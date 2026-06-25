const $ = (selector) => document.querySelector(selector);

const RUBRIC = [
  ["1.1", "流程规范与预期管理", "目标对齐与破冰", 5],
  ["1.2", "流程规范与预期管理", "节奏与时间切分", 5],
  ["2.1", "引导与互动质量", "TTT与STT占比", 5],
  ["2.2", "引导与互动质量", "启发式提问与留白", 5],
  ["3.1", "错题归因与反馈针对性", "学员自诊落实度", 15],
  ["3.2", "错题归因与反馈针对性", "考点降维与痛点打击", 25],
  ["4.1", "练习监督与状态把控", "指令清晰度", 5],
  ["4.2", "练习监督与状态把控", "沉浸式监督与干扰控制", 5],
  ["5.1", "方法强化与Scaffolding", "做题步骤的标准化落地", 10],
  ["5.2", "方法强化与Scaffolding", "举一反三与能力迁移", 10],
  ["6.1", "学员视角与学情捕捉", "学情捕捉与动态调整", 5],
  ["6.2", "学员视角与学情捕捉", "情绪价值与抗挫引导", 5],
].map(([id, dimension, name, weight]) => ({ id, dimension, name, weight }));

const QUESTION_RE = /[？?]|你觉得|为什么|来说|你来|有没有|是什么|怎么|哪些|要不要|能不能|还记得|翻译一下|复述一下|判断/;
const NEGATIVE_RE = /这么简单.*都|笨|无语|不耐烦|嘲讽|叹气|你怎么.*不会|低级错误/;

const els = {
  statusPill: $("#statusPill"),
  fileName: $("#fileName"),
  teacherName: $("#teacherName"),
  transcriptFile: $("#transcriptFile"),
  transcriptText: $("#transcriptText"),
  errorBox: $("#errorBox"),
  analyzeButton: $("#analyzeButton"),
  clearButton: $("#clearButton"),
  scoreValue: $("#scoreValue"),
  gradeValue: $("#gradeValue"),
  teacherValue: $("#teacherValue"),
  durationValue: $("#durationValue"),
  tttValue: $("#tttValue"),
  insightStrip: $("#insightStrip"),
  scoreRows: $("#scoreRows"),
  evidenceList: $("#evidenceList"),
  reportText: $("#reportText"),
  copyReportButton: $("#copyReportButton"),
  downloadReportButton: $("#downloadReportButton"),
};

let latestReport = "";

function cleanText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function secondsFromStamp(value) {
  if (!value) return null;
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function parseTurns(text) {
  const turns = [];
  let current = null;
  const turnRe = /^(.{1,50}?)\((\d{2}:\d{2}:\d{2})\):\s*(.*)$/;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("=====")) continue;
    const match = line.match(turnRe);
    if (match) {
      if (current) turns.push(current);
      current = {
        speaker: match[1].trim(),
        stamp: match[2],
        seconds: secondsFromStamp(match[2]),
        text: match[3].trim(),
      };
    } else if (current) {
      current.text = cleanText(`${current.text} ${line}`);
    }
  }

  if (current) turns.push(current);
  if (turns.length) return turns;

  return text
    .split(/\n{2,}/)
    .map(cleanText)
    .filter(Boolean)
    .map((paragraph) => ({ speaker: "未知", stamp: null, seconds: null, text: paragraph }));
}

function determineTeacher(turns, teacherHint) {
  const speakers = [...new Set(turns.map((turn) => turn.speaker))];
  const hint = cleanText(teacherHint);
  if (hint) {
    const matched = speakers.find(
      (speaker) =>
        speaker.toLowerCase().includes(hint.toLowerCase()) ||
        hint.toLowerCase().includes(speaker.toLowerCase()),
    );
    if (matched) return matched;
  }

  const totals = new Map();
  for (const turn of turns) {
    totals.set(turn.speaker, (totals.get(turn.speaker) || 0) + cleanText(turn.text).length);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "未知";
}

function trimAfterClass(turns, teacher) {
  const teacherTimes = turns.filter((turn) => turn.speaker === teacher && turn.seconds !== null).map((turn) => turn.seconds);
  if (!teacherTimes.length) return turns;
  const cutoff = Math.max(...teacherTimes) + 30;
  const trimmed = turns.filter((turn) => turn.seconds === null || turn.seconds <= cutoff);
  return trimmed.length ? trimmed : turns;
}

function findEvidence(turns, patterns, options = {}) {
  const found = [];
  for (const turn of turns) {
    if (options.speaker && turn.speaker !== options.speaker) continue;
    const text = cleanText(turn.text);
    if (patterns.some((pattern) => pattern.test(text))) {
      found.push({
        speaker: turn.speaker,
        time: turn.stamp || "--:--:--",
        text: text.length > 220 ? `${text.slice(0, 220)}...` : text,
      });
      if (found.length >= (options.limit || 3)) break;
    }
  }
  return found;
}

function countHits(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function levelFromRatio(ratio) {
  if (ratio >= 0.86) return "优秀";
  if (ratio >= 0.6) return "合格";
  return "不合格";
}

function criterion(id, ratio, rationale, evidence, suggestion, metrics = {}) {
  const item = RUBRIC.find((row) => row.id === id);
  const boundedRatio = Math.max(0, Math.min(1, ratio));
  return {
    ...item,
    ratio: boundedRatio,
    points: Math.round(item.weight * boundedRatio * 10) / 10,
    level: levelFromRatio(boundedRatio),
    rationale,
    evidence,
    suggestion,
    metrics,
  };
}

function analyzeTranscript(transcript, teacherHint = "") {
  const allTurns = parseTurns(transcript);
  const teacher = determineTeacher(allTurns, teacherHint);
  const turns = trimAfterClass(allTurns, teacher);
  const studentSpeakers = [...new Set(turns.filter((turn) => turn.speaker !== teacher).map((turn) => turn.speaker))].sort();

  const firstTime = turns.find((turn) => turn.seconds !== null)?.seconds ?? null;
  const lastTime = [...turns].reverse().find((turn) => turn.seconds !== null)?.seconds ?? null;
  const durationSeconds = firstTime !== null && lastTime !== null ? lastTime - firstTime : null;

  const teacherTurns = turns.filter((turn) => turn.speaker === teacher);
  const studentTurns = turns.filter((turn) => turn.speaker !== teacher);
  const teacherText = cleanText(teacherTurns.map((turn) => turn.text).join(" "));
  const studentText = cleanText(studentTurns.map((turn) => turn.text).join(" "));
  const teacherChars = teacherText.length;
  const studentChars = studentText.length;
  const tttRatio = teacherChars / Math.max(1, teacherChars + studentChars);

  const teacherQuestions = teacherTurns.filter((turn) => QUESTION_RE.test(turn.text));
  let questionFollowedByStudent = 0;
  turns.slice(0, -1).forEach((turn, index) => {
    if (turn.speaker === teacher && QUESTION_RE.test(turn.text) && turns[index + 1].speaker !== teacher) {
      questionFollowedByStudent += 1;
    }
  });

  const earlyText =
    firstTime !== null
      ? cleanText(turns.filter((turn) => turn.seconds !== null && turn.seconds <= firstTime + 300).map((turn) => turn.text).join(" "))
      : cleanText(turns.slice(0, 8).map((turn) => turn.text).join(" "));

  const practiceStart =
    teacherTurns.find(
      (turn) => turn.seconds !== null && /开始做题|开始做这个题|开始做|前\s*5\s*个题|前五题/.test(turn.text),
    )?.seconds ?? null;
  const practiceStartElapsed = practiceStart !== null && firstTime !== null ? practiceStart - firstTime : null;

  const issuesHits = countHits(teacherText, [/拼写/, /单复数/, /审题/, /预判/, /同义替换/, /定位/, /痛点/, /薄弱/]);
  const actionHits = countHits(teacherText, [/五遍/, /语料库/, /错词/, /积累/, /复习/, /做掉/, /跟读/, /听写/, /检查/]);
  const methodHits = countHits(teacherText, [/字数要求/, /大小标题/, /关键词/, /预判/, /词性/, /单复数/, /同义替换/, /定位/, /审题步骤/]);
  const transferHits = countHits(teacherText, [/同类/, /规律/, /常考/, /比如/, /举例/, /替换/, /ER|OR|IST|构词/, /however|yet/]);
  const instructionHits = countHits(teacherText, [/打开/, /点到/, /翻到/, /做.*题/, /前\s*5\s*个题|前五题/, /开始做题/, /交卷/]);
  const encouragementHits = countHits(teacherText, [/非常好/, /很好/, /没关系/, /基础.*好/, /太感动/, /不错/, /别紧张/, /正确率.*高/, /不着急/]);
  const dynamicHits = countHits(teacherText, [/卡/, /声音/, /慢慢/, /不着急/, /没听清/, /再来听/, /不知道/, /调整/]);

  const goalHits = countHits(earlyText, [/总分目标|总分/, /单科|听力.*小分/, /正确率|全对|百分之/]);
  const goalRatio = goalHits >= 3 ? 1 : goalHits === 2 ? 0.72 : 0.3;

  let timeRatio = 0.25;
  if (practiceStartElapsed !== null) {
    if (practiceStartElapsed >= 25 * 60 && practiceStartElapsed <= 35 * 60) timeRatio = 0.88;
    else if (practiceStartElapsed >= 18 * 60 && practiceStartElapsed <= 42 * 60) timeRatio = 0.72;
    else timeRatio = 0.58;
  }

  const tttScoreRatio = tttRatio <= 0.75 ? 1 : tttRatio <= 0.85 ? 0.68 : 0.35;
  const questionRatio = Math.min(1, teacherQuestions.length / Math.max(18, teacherTurns.length * 0.38));
  const followRatio = questionFollowedByStudent / Math.max(1, teacherQuestions.length);
  const elicitationRatio = Math.min(1, questionRatio * 0.65 + Math.min(1, followRatio / 0.6) * 0.35);

  const studentSelfDiagnosis =
    /薄弱|拼写|单词|单复数|错|坑|不太清楚|不知道/.test(studentText) &&
    /自我评价|薄弱|痛点|回顾|归因|自己/.test(teacherText);
  const selfDiagRatio = studentSelfDiagnosis ? 1 : /回顾|你来|你觉得/.test(teacherText) ? 0.65 : 0.25;
  const painRatio = issuesHits >= 4 && actionHits >= 3 ? 1 : issuesHits >= 3 ? 0.7 : 0.35;
  const instructionRatio = instructionHits >= 5 ? 0.9 : instructionHits >= 3 ? 0.68 : 0.35;

  let supervisionRatio = 0.3;
  if (practiceStart !== null) {
    const practiceWindow = turns.filter((turn) => turn.seconds !== null && turn.seconds > practiceStart && turn.seconds <= practiceStart + 180);
    const teacherInterruptions = practiceWindow.filter((turn) => turn.speaker === teacher);
    supervisionRatio = teacherInterruptions.length === 0 ? 1 : teacherInterruptions.length <= 1 ? 0.78 : 0.42;
  }

  const methodRatio = methodHits >= 7 ? 1 : methodHits >= 4 ? 0.72 : 0.35;
  const transferRatio = transferHits >= 5 ? 0.92 : transferHits >= 3 ? 0.68 : 0.3;
  const dynamicRatio = dynamicHits >= 5 ? 0.9 : dynamicHits >= 3 ? 0.68 : 0.35;
  const emotionRatio = encouragementHits >= 6 && !NEGATIVE_RE.test(teacherText) ? 0.95 : encouragementHits >= 2 ? 0.68 : 0.3;

  const criteria = [
    criterion("1.1", goalRatio, `开场阶段检测到目标相关要素 ${goalHits}/3 项。`, findEvidence(turns, [/总分目标|总分/, /单科|听力.*小分/, /正确率|全对/], { speaker: teacher }), "继续把总分、单科目标、当前题型正确率三者固定为开场核对清单。"),
    criterion("1.2", timeRatio, `检测到现场带练环节${practiceStartElapsed !== null ? `约在开课后 ${Math.round((practiceStartElapsed / 60) * 10) / 10} 分钟开始。` : "不足。"}`, findEvidence(turns, [/开始做题|前\s*5\s*个题|前五题|真题讲解|下面我要/], { speaker: teacher }), "建议在报告中标注复盘与新题带练的实际分钟数，方便跨课对比。"),
    criterion("2.1", tttScoreRatio, `按文字量估算，教师话语占比约 ${Math.round(tttRatio * 1000) / 10}%。`, findEvidence(turns, [/OK|那么|老师|我们/], { speaker: teacher }), "教师讲解质量较高时也要注意压缩连续讲授，把更多复述和总结交给学员。"),
    criterion("2.2", elicitationRatio, `检测到教师提问 ${teacherQuestions.length} 次，其中后续接学员回答约 ${questionFollowedByStudent} 次。`, findEvidence(turns, [/你觉得|为什么|你来|有没有|是什么|怎么|哪些|要不要/], { speaker: teacher }), "保留现有追问习惯，关键题后可增加3-5秒留白，减少同一回合内直接解释。"),
    criterion("3.1", selfDiagRatio, "检测到教师先让学员表达薄弱点或解题思路，再进行纠偏。", findEvidence(turns, [/自我评价|薄弱|痛点|回顾|你是怎么做出来|解题思路/], { limit: 4 }), "继续要求学员先说错因，再由教师补充归因。"),
    criterion("3.2", painRatio, `检测到痛点类表达 ${issuesHits} 类，解决动作 ${actionHits} 类。`, findEvidence(turns, [/拼写|单复数|预判|同义替换|五遍|语料库|错词|积累/], { speaker: teacher, limit: 5 }), "很适合沉淀为个人错词表、单复数预判清单和课后追踪项。"),
    criterion("4.1", instructionRatio, `检测到任务指令相关表达 ${instructionHits} 类。`, findEvidence(turns, [/打开|点到|翻到|做.*题|前\s*5\s*个题|前五题|开始做题|交卷/], { speaker: teacher, limit: 4 }), "每次开始练习前建议补一句确认语，例如“你现在清楚做几题、做到哪里提交吗”。"),
    criterion("4.2", supervisionRatio, "检测到学员做题窗口，教师基本未在短时间内连续打断。", findEvidence(turns, [/开始做题|别紧张|老师.*玩去了|就写前|检查完善/], { limit: 4 }), "可在质检记录中补充教师是否观察到勾画关键词、预判词性等行为细节。"),
    criterion("5.1", methodRatio, `检测到标准做题步骤相关要素 ${methodHits} 类。`, findEvidence(turns, [/字数要求|大小标题|关键词|预判|词性|单复数|同义替换|定位|审题步骤/], { speaker: teacher, limit: 5 }), "可以让学员在每道新题前完整复述一次“审题-预判-定位-核对”的步骤。"),
    criterion("5.2", transferRatio, `检测到迁移拓展相关要素 ${transferHits} 类。`, findEvidence(turns, [/同义替换|常考|比如|构词|ER|OR|IST|规律|同类/], { speaker: teacher, limit: 5 }), "后续报告可单独记录“可迁移规律”，方便教研复盘。"),
    criterion("6.1", dynamicRatio, `检测到学情/状态调整相关表达 ${dynamicHits} 类。`, findEvidence(turns, [/卡|声音|慢慢|不着急|没听清|再来听|不知道/], { limit: 5 }), "建议继续保留设备问题和答不上来时的节奏缓冲。"),
    criterion("6.2", emotionRatio, `检测到鼓励或情绪支持表达 ${encouragementHits} 类。`, findEvidence(turns, [/非常好|很好|没关系|基础.*好|太感动|不错|别紧张|正确率.*高|不着急/], { speaker: teacher, limit: 5 }), "鼓励已经较多，质检时可优先看鼓励是否有具体依据。"),
  ];

  const fatalFlags = [];
  if (NEGATIVE_RE.test(teacherText)) {
    fatalFlags.push({
      name: "负面情绪与态度红线",
      detected: true,
      evidence: findEvidence(turns, [NEGATIVE_RE], { speaker: teacher, limit: 2 }),
    });
  }
  if (painRatio < 0.6 && actionHits === 0) {
    fatalFlags.push({
      name: "无闭环解决方案风险",
      detected: false,
      evidence: [],
      note: "自动检测到闭环证据不足，需人工复核是否触发红线。",
    });
  }

  const rawScore = Math.round(criteria.reduce((sum, row) => sum + row.points, 0) * 10) / 10;
  const score = fatalFlags.some((flag) => flag.detected) ? 0 : rawScore;
  const grade = score >= 90 ? "S" : score >= 80 ? "A" : score >= 70 ? "B" : "C";
  const gradeAdvice = {
    S: "可作为优秀样例进入教研复盘，重点沉淀可复制动作。",
    A: "常规达标，建议反馈1-2个微操提升点。",
    B: "合格但有明显短板，建议针对薄弱维度复检。",
    C: "不合格或疑似触发红线，建议人工复核后整改。",
  }[grade];

  return {
    teacher,
    studentSpeakers,
    durationSeconds,
    durationLabel: durationSeconds !== null ? `${Math.round((durationSeconds / 60) * 10) / 10} 分钟` : "未识别",
    turnCount: turns.length,
    ignoredTailTurns: Math.max(0, allTurns.length - turns.length),
    teacherTalkRatio: Math.round(tttRatio * 1000) / 1000,
    score,
    rawScore,
    grade,
    gradeAdvice,
    criteria,
    fatalFlags,
    report: buildReport({ score, grade, gradeAdvice, teacher, studentSpeakers, durationSeconds, criteria, fatalFlags }),
  };
}

function buildReport(input) {
  const strengths = input.criteria.filter((row) => row.ratio >= 0.86).slice(0, 3);
  const weaknesses = [...input.criteria].sort((a, b) => a.points / a.weight - b.points / b.weight).slice(0, 3);
  const lines = [
    "# 雅思带练课质检报告",
    "",
    `- 授课老师：${input.teacher}`,
    `- 学员：${input.studentSpeakers.join("、") || "未识别"}`,
    `- 课堂时长：${input.durationSeconds !== null ? `${Math.round((input.durationSeconds / 60) * 10) / 10} 分钟` : "未识别"}`,
    `- 综合得分：${input.score}/100`,
    `- 评级：${input.grade}`,
    `- 处理建议：${input.gradeAdvice}`,
    "",
    "## 总体结论",
    input.fatalFlags.length ? "系统检测到红线风险或复核提示，需人工确认后再定稿。" : "未自动检测到明确教学红线，建议按下方维度证据进行人工复核。",
    "",
    "## 主要亮点",
    ...strengths.map((row) => `- ${row.id} ${row.name}：${row.level}。证据：${row.evidence[0]?.text || row.rationale}`),
    "",
    "## 重点改进",
    ...weaknesses.map((row) => `- ${row.id} ${row.name}：${row.points}/${row.weight}。${row.suggestion}`),
    "",
    "## 维度评分",
    ...input.criteria.map((row) => `- ${row.id} ${row.name}：${row.points}/${row.weight}（${row.level}）`),
    "",
    "## 证据摘录",
  ];

  input.criteria.forEach((row) => {
    if (!row.evidence.length) return;
    lines.push(`### ${row.id} ${row.name}`);
    row.evidence.slice(0, 2).forEach((item) => {
      lines.push(`- ${item.speaker}(${item.time})：${item.text}`);
    });
  });

  if (input.fatalFlags.length) {
    lines.push("", "## 红线复核");
    input.fatalFlags.forEach((flag) => {
      lines.push(`- ${flag.name}：${flag.detected ? "疑似触发" : "需复核"}`);
      if (flag.note) lines.push(`  ${flag.note}`);
    });
  }

  return lines.join("\n");
}

async function extractPdfText(file) {
  const pdfjsLib = await import("./vendor/pdfjs/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str || "").join(" ");
    pages.push(`===== Page ${pageNumber} =====\n${text}`);
  }

  return pages.join("\n\n");
}

async function extractFileText(file) {
  const suffix = file.name.split(".").pop()?.toLowerCase();
  if (suffix === "pdf") return extractPdfText(file);
  if (suffix === "txt" || suffix === "csv") return file.text();
  throw new Error("当前分享版支持 PDF、TXT、CSV。Word 文档可以先复制文本后粘贴。");
}

function setStatus(text, isError = false) {
  els.statusPill.textContent = text;
  els.statusPill.classList.toggle("error", isError);
}

function setError(message) {
  els.errorBox.textContent = message;
  els.errorBox.classList.toggle("hidden", !message);
  setStatus(message ? "需要处理" : "待分析", Boolean(message));
}

function levelClass(level) {
  if (level === "优秀") return "good";
  if (level === "合格") return "mid";
  return "low";
}

function formatPercent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function renderScores(criteria) {
  els.scoreRows.innerHTML = "";
  if (!criteria.length) {
    els.scoreRows.innerHTML = '<tr><td colspan="4" class="empty-cell">等待分析结果</td></tr>';
    return;
  }
  criteria.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${row.id} ${row.name}</strong><div class="muted">${row.dimension}</div></td>
      <td><span class="level ${levelClass(row.level)}">${row.level}</span></td>
      <td><strong>${row.points}</strong> / ${row.weight}</td>
      <td>${row.rationale}<br><span class="muted">${row.suggestion}</span></td>
    `;
    els.scoreRows.appendChild(tr);
  });
}

function renderEvidence(result) {
  els.evidenceList.innerHTML = "";
  if (!result) {
    els.evidenceList.innerHTML = '<div class="empty-state">等待证据摘录</div>';
    return;
  }
  let count = 0;
  result.criteria.forEach((row) => {
    row.evidence.forEach((item) => {
      const article = document.createElement("article");
      article.className = "evidence-item";
      article.innerHTML = `
        <div class="evidence-title">${row.id} ${row.name}</div>
        <div class="evidence-meta">${item.speaker} · ${item.time}</div>
        <p>${item.text}</p>
      `;
      els.evidenceList.appendChild(article);
      count += 1;
    });
  });
  if (!count) els.evidenceList.innerHTML = '<div class="empty-state">没有可展示的证据</div>';
}

function renderInsights(criteria) {
  const weakest = [...criteria].sort((a, b) => a.points / a.weight - b.points / b.weight).slice(0, 3);
  els.insightStrip.innerHTML = "";
  weakest.forEach((row) => {
    const div = document.createElement("div");
    div.innerHTML = `<span>${row.id}</span><strong>${row.name}</strong><small>${row.points}/${row.weight}</small>`;
    els.insightStrip.appendChild(div);
  });
  els.insightStrip.classList.toggle("hidden", !weakest.length);
}

function renderResult(result) {
  els.scoreValue.textContent = result.score;
  els.gradeValue.textContent = `${result.grade} 级`;
  els.teacherValue.textContent = result.teacher || "--";
  els.durationValue.textContent = result.durationLabel || "--";
  els.tttValue.textContent = formatPercent(result.teacherTalkRatio);
  renderScores(result.criteria);
  renderEvidence(result);
  renderInsights(result.criteria);
  latestReport = result.report;
  els.reportText.value = latestReport;
  setStatus("已完成");
}

function clearResult() {
  els.scoreValue.textContent = "--";
  els.gradeValue.textContent = "--";
  els.teacherValue.textContent = "--";
  els.durationValue.textContent = "--";
  els.tttValue.textContent = "--";
  els.insightStrip.classList.add("hidden");
  renderScores([]);
  renderEvidence(null);
  els.reportText.value = "";
  latestReport = "";
}

function downloadReport() {
  const text = els.reportText.value || latestReport;
  if (!text) return;
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `雅思带练课质检报告-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

els.transcriptFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  els.fileName.textContent = file.name;
  setError("");
  setStatus("读取中");
  els.analyzeButton.disabled = true;
  try {
    els.transcriptText.value = await extractFileText(file);
    setStatus("已读取");
  } catch (error) {
    setError(error instanceof Error ? error.message : "文件读取失败");
  } finally {
    els.analyzeButton.disabled = false;
  }
});

els.analyzeButton.addEventListener("click", () => {
  setError("");
  if (!els.transcriptText.value.trim()) {
    setError("请先上传或粘贴课堂逐字稿。");
    return;
  }
  setStatus("分析中");
  els.analyzeButton.disabled = true;
  window.setTimeout(() => {
    try {
      renderResult(analyzeTranscript(els.transcriptText.value, els.teacherName.value));
      document.querySelector('[data-tab="scores"]').click();
    } catch (error) {
      setError(error instanceof Error ? error.message : "分析失败");
    } finally {
      els.analyzeButton.disabled = false;
    }
  }, 10);
});

els.clearButton.addEventListener("click", () => {
  els.teacherName.value = "";
  els.transcriptFile.value = "";
  els.transcriptText.value = "";
  els.fileName.textContent = "";
  clearResult();
  setError("");
  setStatus("待分析");
});

els.copyReportButton.addEventListener("click", async () => {
  const text = els.reportText.value || latestReport;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus("已复制");
});

els.downloadReportButton.addEventListener("click", downloadReport);

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    $(`#${button.dataset.tab}Panel`).classList.add("active");
  });
});

clearResult();
