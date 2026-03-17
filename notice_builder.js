const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const puppeteer = require("puppeteer");

const FILES = {
  calc: path.join(__dirname, "penalty_calc_output.txt"),
  audit: path.join(__dirname, "penalty_audit.txt"),
  summaryHtml: path.join(__dirname, "notice_summary.html"),
  priorityHtml: path.join(__dirname, "notice_priority.html"),
  allHtml: path.join(__dirname, "all_notices.html"),
  pdf: path.join(__dirname, "all_notices.pdf"),
  manifest: path.join(__dirname, "notice_manifest.txt"),
  failed: path.join(__dirname, "notice_failed.txt"),
  log: path.join(__dirname, "notice_log.txt")
};

const CONFIG = {
  oldHtmlBase: "http://results.beup.ac.in/ResultsBTech2ndSem2024_B2023Pub.aspx",
  currentResult: {
    year: "2025",
    semester: "II",
    examHeld: "November/2025"
  },
  timeoutMs: 30000,
  maxRetries: 3,
  retryDelayMs: 1500,
  politeDelayMs: 300
};

function ensureFile(filePath, defaultContent = "") {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, "utf8");
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(FILES.log, line + "\n", "utf8");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseNumber(raw) {
  const cleaned = String(raw ?? "").replace(/[^\d.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function splitMulti(v) {
  return String(v || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function parsePipeLine(line) {
  return line.split("|").map(x => x.trim());
}

function buildOldUrl(regNo) {
  return `${CONFIG.oldHtmlBase}?Sem=II&RegNo=${regNo}`;
}

function buildNewUrl(regNo) {
  const u = new URL("https://beu-bih.ac.in/backend/v1/result/get-result");
  u.searchParams.set("year", CONFIG.currentResult.year);
  u.searchParams.set("redg_no", regNo);
  u.searchParams.set("semester", CONFIG.currentResult.semester);
  u.searchParams.set("exam_held", CONFIG.currentResult.examHeld);
  return u.toString();
}

async function fetchWithRetries(url, expectJson = false) {
  let delay = CONFIG.retryDelayMs;

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: CONFIG.timeoutMs,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": expectJson
            ? "application/json, text/plain, */*"
            : "text/html,application/xhtml+xml"
        },
        validateStatus: status => status >= 200 && status < 500
      });

      if (response.status !== 200) {
        return { kind: "ERROR", error: `HTTP ${response.status}` };
      }

      if (expectJson) {
        if (!response.data || response.data.status !== 200 || !response.data.data) {
          return { kind: "NO_RECORD" };
        }
        return { kind: "FOUND", data: response.data.data };
      }

      if (typeof response.data === "string" && !response.data.includes("No Record Found !!!")) {
        return { kind: "FOUND", html: response.data };
      }

      return { kind: "NO_RECORD" };
    } catch (error) {
      if (attempt === CONFIG.maxRetries) {
        return { kind: "ERROR", error: error.message };
      }
      await sleep(delay);
      delay *= 2;
    }
  }

  return { kind: "ERROR", error: "Unknown fetch error" };
}

function parseOldHtml(html) {
  const $ = cheerio.load(html);

  const meta = {
    reg_no: $("#ContentPlaceHolder1_DataList1_RegistrationNoLabel_0").text().trim() || "",
    student_name: $("#ContentPlaceHolder1_DataList1_StudentNameLabel_0").text().trim() || "",
    college_name: $("#ContentPlaceHolder1_DataList1_CollegeNameLabel_0").text().trim() || "",
    course_name: $("#ContentPlaceHolder1_DataList1_CourseLabel_0").text().trim() || "",
    shown_sgpa:
      $("#ContentPlaceHolder1_DataList5_GROSSTHEORYTOTALLabel_0").text().trim() ||
      "",
    shown_cgpa:
      $("#ContentPlaceHolder1_GridView3 tr:nth-child(2) td:last-child").text().trim() ||
      ""
  };

  const theory = [];
  $("#ContentPlaceHolder1_GridView1 tr").slice(1).each((_, el) => {
    const tds = $(el).find("td");
    if (tds.length >= 7) {
      theory.push({
        code: $(tds[0]).text().trim(),
        name: $(tds[1]).text().trim(),
        ese: $(tds[2]).text().trim(),
        ia: $(tds[3]).text().trim(),
        total: $(tds[4]).text().trim(),
        grade: $(tds[5]).text().trim(),
        credit: $(tds[6]).text().trim()
      });
    }
  });

  const practical = [];
  $("#ContentPlaceHolder1_GridView2 tr").slice(1).each((_, el) => {
    const tds = $(el).find("td");
    if (tds.length >= 7) {
      practical.push({
        code: $(tds[0]).text().trim(),
        name: $(tds[1]).text().trim(),
        ese: $(tds[2]).text().trim(),
        ia: $(tds[3]).text().trim(),
        total: $(tds[4]).text().trim(),
        grade: $(tds[5]).text().trim(),
        credit: $(tds[6]).text().trim()
      });
    }
  });

  return { meta, theory, practical };
}

function parseNewJson(data) {
  const meta = {
    reg_no: String(data.redg_no || ""),
    student_name: String(data.name || ""),
    college_name: String(data.college_name || ""),
    course_name: String(data.course || ""),
    shown_sgpa: String((data.sgpa && data.sgpa[1]) || ""),
    shown_cgpa: String(data.cgpa || "")
  };

  const theory = (data.theorySubjects || []).map(s => ({
    code: String(s.code || ""),
    name: String(s.name || ""),
    ese: String(s.ese || ""),
    ia: String(s.ia || ""),
    total: String(s.total || ""),
    grade: String(s.grade || ""),
    credit: String(s.credit || "")
  }));

  const practical = (data.practicalSubjects || []).map(s => ({
    code: String(s.code || ""),
    name: String(s.name || ""),
    ese: String(s.ese || ""),
    ia: String(s.ia || ""),
    total: String(s.total || ""),
    grade: String(s.grade || ""),
    credit: String(s.credit || "")
  }));

  return { meta, theory, practical };
}

function loadPenaltyCalc() {
  const raw = fs.readFileSync(FILES.calc, "utf8")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(line => !/^reg_no\s*\|/i.test(line));

  return raw.map(line => {
    const p = parsePipeLine(line);
    return {
      reg_no: p[0] || "",
      branch_code: p[1] || "",
      penalized_subject_codes: splitMulti(p[2] || ""),
      subject_names: splitMulti(p[3] || ""),
      old_shown_grades: splitMulti(p[4] || ""),
      new_shown_grades: splitMulti(p[5] || ""),
      should_be_grades: splitMulti(p[6] || ""),
      shown_sgpa: p[7] || "",
      corrected_sgpa: p[8] || "",
      shown_cgpa: p[9] || "",
      corrected_cgpa: p[10] || "",
      status: p[11] || ""
    };
  }).filter(x => x.reg_no);
}

function loadAudit() {
  const raw = fs.readFileSync(FILES.audit, "utf8")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(line => !/^reg_no\s*\|/i.test(line));

  const byReg = new Map();

  for (const line of raw) {
    const p = parsePipeLine(line);
    const row = {
      reg_no: p[0] || "",
      sem: p[1] || "",
      subject_code: p[2] || "",
      subject_name: p[3] || "",
      credit: p[4] || "",
      old_shown_grade: p[5] || "",
      new_shown_grade: p[6] || "",
      should_be_grade: p[7] || "",
      shown_gp: p[8] || "",
      corrected_gp: p[9] || "",
      delta_points: p[10] || ""
    };
    if (!byReg.has(row.reg_no)) byReg.set(row.reg_no, []);
    byReg.get(row.reg_no).push(row);
  }

  return byReg;
}

function renderSubjectTable(title, subjects, penalizedSet, shouldMap, mode) {
  const rows = subjects.map(s => {
    const isPen = penalizedSet.has(s.code);
    const should = shouldMap.get(s.code) || "";
    const gradeCell = isPen
      ? `<span class="${mode === "old" ? "old-grade" : "new-grade"}">${esc(s.grade)}</span>`
      : esc(s.grade);

    const shouldCell = mode === "new"
      ? (isPen
          ? `<span class="real-grade">${esc(should || "-")}</span>`
          : `<span class="muted">-</span>`)
      : (isPen ? `<span class="issue-note">Penalty source</span>` : `<span class="muted">-</span>`);

    return `
      <tr class="${isPen ? "pen-row" : ""}">
        <td>${esc(s.code)}</td>
        <td>${esc(s.name)}</td>
        <td>${esc(s.ese)}</td>
        <td>${esc(s.ia)}</td>
        <td>${esc(s.total)}</td>
        <td>${gradeCell}</td>
        <td>${esc(s.credit)}</td>
        <td>${shouldCell}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="section">
      <h4>${esc(title)}</h4>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Subject</th>
            <th>ESE</th>
            <th>IA</th>
            <th>Total</th>
            <th>${mode === "old" ? "Old Grade" : "New Grade"}</th>
            <th>Credit</th>
            <th>${mode === "old" ? "Note" : "Should Be"}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderCase(student, auditRows, oldParsed, newParsed) {
  const penalizedSet = new Set(student.penalized_subject_codes);
  const shouldMap = new Map(auditRows.map(a => [a.subject_code, a.should_be_grade]));

  const oldTheory = renderSubjectTable("Old Result - Theory", oldParsed.theory, penalizedSet, shouldMap, "old");
  const oldPractical = renderSubjectTable("Old Result - Practical", oldParsed.practical, penalizedSet, shouldMap, "old");
  const newTheory = renderSubjectTable("New Result - Theory", newParsed.theory, penalizedSet, shouldMap, "new");
  const newPractical = renderSubjectTable("New Result - Practical", newParsed.practical, penalizedSet, shouldMap, "new");

  const oldUrl = buildOldUrl(student.reg_no);
  const newUrl = buildNewUrl(student.reg_no);

  const penalizedList = auditRows.map(a =>
    `<li><b>${esc(a.subject_code)}</b> — ${esc(a.subject_name)} | old ${esc(a.old_shown_grade)} → new shown ${esc(a.new_shown_grade)} → should be ${esc(a.should_be_grade)}</li>`
  ).join("");

  const deltaSgpa = (() => {
    const a = parseNumber(student.shown_sgpa);
    const b = parseNumber(student.corrected_sgpa);
    return (a !== null && b !== null) ? (b - a).toFixed(2) : "-";
  })();

  const deltaCgpa = (() => {
    const a = parseNumber(student.shown_cgpa);
    const b = parseNumber(student.corrected_cgpa);
    return (a !== null && b !== null) ? (b - a).toFixed(2) : "-";
  })();

  const meta = newParsed.meta.student_name || oldParsed.meta.student_name
    ? {
        student_name: newParsed.meta.student_name || oldParsed.meta.student_name,
        college_name: newParsed.meta.college_name || oldParsed.meta.college_name,
        course_name: newParsed.meta.course_name || oldParsed.meta.course_name
      }
    : {
        student_name: "",
        college_name: "",
        course_name: ""
      };

  return `
    <article class="case">
      <div class="case-header">
        <div>
          <h2>${esc(meta.student_name || "Student")}</h2>
          <div class="meta">
            <div><b>Reg No:</b> ${esc(student.reg_no)}</div>
            <div><b>Branch Code:</b> ${esc(student.branch_code)}</div>
            <div><b>Course:</b> ${esc(meta.course_name)}</div>
            <div><b>College:</b> ${esc(meta.college_name)}</div>
            <div><b>Status:</b> ${esc(student.status)}</div>
          </div>
        </div>
        <div class="links">
          <div><a href="${esc(oldUrl)}">Old Result Link</a></div>
          <div><a href="${esc(newUrl)}">New Result Link</a></div>
        </div>
      </div>

      <div class="impact-box">
        <div><b>Penalized Subjects:</b> ${esc(student.penalized_subject_codes.join(", "))}</div>
        <div><b>Shown SGPA:</b> ${esc(student.shown_sgpa)} &nbsp; <b>Corrected SGPA:</b> <span class="real-grade">${esc(student.corrected_sgpa)}</span> &nbsp; <b>Delta:</b> ${esc(deltaSgpa)}</div>
        <div><b>Shown CGPA:</b> ${esc(student.shown_cgpa)} &nbsp; <b>Corrected CGPA:</b> <span class="real-grade">${esc(student.corrected_cgpa)}</span> &nbsp; <b>Delta:</b> ${esc(deltaCgpa)}</div>
      </div>

      <div class="issue-box">
        <b>Comparison Summary</b>
        <ul>${penalizedList}</ul>
      </div>

      ${oldTheory}
      ${oldPractical}
      ${newTheory}
      ${newPractical}
    </article>
  `;
}

function buildPage(title, bodyHtml, extraHead = "") {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <style>
    @page { size: A4 portrait; margin: 12mm; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 12px; line-height: 1.35; }
    h1, h2, h3, h4 { margin: 0 0 8px 0; }
    .summary-card, .impact-box, .issue-box {
      border: 2px solid #b91c1c;
      border-radius: 8px;
      padding: 10px;
      margin: 10px 0;
      background: #fff;
    }
    .case { page-break-after: always; border: 1px solid #ddd; padding: 10px; margin-bottom: 10px; }
    .case-header { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
    .meta div, .links div { margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 14px 0; }
    th, td { border: 1px solid #444; padding: 4px 6px; vertical-align: top; }
    th { background: #efefef; }
    .pen-row { background: #fff7cc; }
    .old-grade, .new-grade {
      display: inline-block;
      padding: 2px 10px;
      border: 3px solid #eab308;
      border-radius: 999px;
      background: #fef3c7;
      font-weight: 700;
    }
    .real-grade {
      display: inline-block;
      padding: 2px 8px;
      border: 3px solid #16a34a;
      border-radius: 6px;
      background: #dcfce7;
      font-weight: 700;
    }
    .issue-note {
      display: inline-block;
      padding: 2px 6px;
      border: 2px dashed #d97706;
      background: #fff7ed;
      border-radius: 6px;
      font-weight: 700;
    }
    .muted { color: #777; }
    .section { margin-top: 8px; }
    .toc li { margin-bottom: 3px; }
    ${extraHead}
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function summarize(calcRows, auditMap) {
  const totalStudents = calcRows.length;
  let totalSubjects = 0;
  let totalDeltaSgpa = 0;
  let totalDeltaCgpa = 0;
  const branchCount = new Map();
  const subjectCount = new Map();
  const multiCount = { one: 0, two: 0, threePlus: 0 };

  for (const row of calcRows) {
    const codes = row.penalized_subject_codes;
    totalSubjects += codes.length;

    if (codes.length === 1) multiCount.one++;
    else if (codes.length === 2) multiCount.two++;
    else if (codes.length >= 3) multiCount.threePlus++;

    branchCount.set(row.branch_code, (branchCount.get(row.branch_code) || 0) + 1);

    const ds = parseNumber(row.corrected_sgpa) - parseNumber(row.shown_sgpa);
    const dc = parseNumber(row.corrected_cgpa) - parseNumber(row.shown_cgpa);
    if (Number.isFinite(ds)) totalDeltaSgpa += ds;
    if (Number.isFinite(dc)) totalDeltaCgpa += dc;

    const auditRows = auditMap.get(row.reg_no) || [];
    for (const a of auditRows) {
      subjectCount.set(a.subject_code, (subjectCount.get(a.subject_code) || 0) + 1);
    }
  }

  const topBranches = Array.from(branchCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topSubjects = Array.from(subjectCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);

  return {
    totalStudents,
    totalSubjects,
    avgSubjectsPerStudent: totalStudents ? (totalSubjects / totalStudents).toFixed(2) : "0.00",
    avgDeltaSgpa: totalStudents ? (totalDeltaSgpa / totalStudents).toFixed(2) : "0.00",
    avgDeltaCgpa: totalStudents ? (totalDeltaCgpa / totalStudents).toFixed(2) : "0.00",
    topBranches,
    topSubjects,
    multiCount
  };
}

function renderSummaryPage(summary) {
  const branchRows = summary.topBranches.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  const subjectRows = summary.topSubjects.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");

  const body = `
    <h1>BEU Penalty Comparison Summary</h1>
    <div class="summary-card">
      <div><b>Total Penalized Students:</b> ${esc(summary.totalStudents)}</div>
      <div><b>Total Penalized Subject Rows:</b> ${esc(summary.totalSubjects)}</div>
      <div><b>Average Penalized Subjects Per Student:</b> ${esc(summary.avgSubjectsPerStudent)}</div>
      <div><b>Average SGPA Increase:</b> ${esc(summary.avgDeltaSgpa)}</div>
      <div><b>Average CGPA Increase:</b> ${esc(summary.avgDeltaCgpa)}</div>
      <div><b>1 Subject Cases:</b> ${esc(summary.multiCount.one)}</div>
      <div><b>2 Subject Cases:</b> ${esc(summary.multiCount.two)}</div>
      <div><b>3+ Subject Cases:</b> ${esc(summary.multiCount.threePlus)}</div>
    </div>

    <div class="summary-card">
      <h3>Top Branches by Student Count</h3>
      <table>
        <thead><tr><th>Branch Code</th><th>Students</th></tr></thead>
        <tbody>${branchRows}</tbody>
      </table>
    </div>

    <div class="summary-card">
      <h3>Top Subject Codes by Penalty Frequency</h3>
      <table>
        <thead><tr><th>Subject Code</th><th>Count</th></tr></thead>
        <tbody>${subjectRows}</tbody>
      </table>
    </div>
  `;

  return buildPage("BEU Penalty Summary", body);
}

function renderPriorityPage(calcRows, auditMap) {
  const priorities = calcRows
    .map(r => {
      const ds = parseNumber(r.corrected_sgpa) - parseNumber(r.shown_sgpa);
      const dc = parseNumber(r.corrected_cgpa) - parseNumber(r.shown_cgpa);
      return { ...r, delta_sgpa: ds, delta_cgpa: dc, auditCount: (auditMap.get(r.reg_no) || []).length };
    })
    .filter(r => r.auditCount >= 3 || r.delta_sgpa >= 0.40 || r.delta_cgpa >= 0.15)
    .sort((a, b) => (b.delta_sgpa || 0) - (a.delta_sgpa || 0));

  const rows = priorities.map(r => `
    <tr>
      <td>${esc(r.reg_no)}</td>
      <td>${esc(r.branch_code)}</td>
      <td>${esc(r.penalized_subject_codes.join(", "))}</td>
      <td>${esc(r.shown_sgpa)}</td>
      <td>${esc(r.corrected_sgpa)}</td>
      <td>${Number.isFinite(r.delta_sgpa) ? r.delta_sgpa.toFixed(2) : "-"}</td>
      <td>${esc(r.shown_cgpa)}</td>
      <td>${esc(r.corrected_cgpa)}</td>
      <td>${Number.isFinite(r.delta_cgpa) ? r.delta_cgpa.toFixed(2) : "-"}</td>
    </tr>
  `).join("");

  return buildPage("BEU Priority Cases", `
    <h1>Priority Cases</h1>
    <div class="summary-card">
      <div>This file lists high-impact cases first.</div>
      <div>Rule used: 3+ penalized subjects or SGPA delta ≥ 0.40 or CGPA delta ≥ 0.15</div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Reg No</th>
          <th>Branch</th>
          <th>Penalized Subject Codes</th>
          <th>Shown SGPA</th>
          <th>Corrected SGPA</th>
          <th>Δ SGPA</th>
          <th>Shown CGPA</th>
          <th>Corrected CGPA</th>
          <th>Δ CGPA</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `);
}

async function renderPdfFromHtml(htmlPath, pdfPath) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "8mm", bottom: "10mm", left: "8mm" }
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  ensureFile(FILES.failed, "");
  ensureFile(FILES.log, "");
  ensureFile(FILES.manifest, "");

  const calcRows = loadPenaltyCalc().filter(r => (r.status || "").toUpperCase().includes("PENALTY"));
  const auditMap = loadAudit();

  log(`Loaded ${calcRows.length} confirmed penalty students`);

  const summary = summarize(calcRows, auditMap);
  fs.writeFileSync(FILES.summaryHtml, renderSummaryPage(summary), "utf8");
  fs.writeFileSync(FILES.priorityHtml, renderPriorityPage(calcRows, auditMap), "utf8");

  const cases = [];
  const manifest = [];

  for (let i = 0; i < calcRows.length; i++) {
    const row = calcRows[i];
    const regNo = row.reg_no;
    const oldUrl = buildOldUrl(regNo);
    const newUrl = buildNewUrl(regNo);

    const oldFetched = await fetchWithRetries(oldUrl, false);
    if (oldFetched.kind !== "FOUND") {
      fs.appendFileSync(FILES.failed, `${regNo} | OLD_FETCH_FAILED | ${oldUrl}\n`, "utf8");
      log(`[${i + 1}/${calcRows.length}] ${regNo} -> OLD_FETCH_FAILED`);
      continue;
    }

    const newFetched = await fetchWithRetries(newUrl, true);
    if (newFetched.kind !== "FOUND") {
      fs.appendFileSync(FILES.failed, `${regNo} | NEW_FETCH_FAILED | ${newUrl}\n`, "utf8");
      log(`[${i + 1}/${calcRows.length}] ${regNo} -> NEW_FETCH_FAILED`);
      continue;
    }

    const oldParsed = parseOldHtml(oldFetched.html);
    const newParsed = parseNewJson(newFetched.data);
    const auditRows = auditMap.get(regNo) || [];

    const caseHtml = renderCase(row, auditRows, oldParsed, newParsed);
    cases.push(caseHtml);
    manifest.push(`${regNo} | OK | ${oldUrl} | ${newUrl}`);

    log(`[${i + 1}/${calcRows.length}] ${regNo} -> NOTICE_READY`);
    await sleep(CONFIG.politeDelayMs);
  }

  const allBody = `
    <h1>BEU Penalty Comparison Notices</h1>
    <div class="summary-card">
      <div><b>Total Cases Rendered:</b> ${esc(cases.length)}</div>
      <div><b>Old Result Source:</b> ${esc(CONFIG.oldHtmlBase)}</div>
      <div><b>New Result Source:</b> ${esc(CONFIG.currentResult.year)} / ${esc(CONFIG.currentResult.examHeld)}</div>
    </div>
    ${cases.join("\n")}
  `;

  fs.writeFileSync(FILES.allHtml, buildPage("BEU All Notices", allBody), "utf8");
  fs.writeFileSync(FILES.manifest, manifest.join("\n") + "\n", "utf8");

  log(`Rendering PDF...`);
  await renderPdfFromHtml(FILES.allHtml, FILES.pdf);
  log(`PDF ready: ${FILES.pdf}`);
}

main().catch(err => {
  log(`FATAL ${err.stack || err.message}`);
  process.exit(1);
});
