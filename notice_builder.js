const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const FILES = {
  output: path.join(__dirname, 'penalty_calc_output.txt'),
  audit: path.join(__dirname, 'penalty_audit.txt'),
  allHtml: path.join(__dirname, 'all_notices.html'),
  allPdf: path.join(__dirname, 'all_notices.pdf'),
  summaryHtml: path.join(__dirname, 'notice_summary.html'),
  priorityHtml: path.join(__dirname, 'notice_priority.html'),
  manifest: path.join(__dirname, 'notice_manifest.txt'),
  failed: path.join(__dirname, 'notice_failed.txt'),
  log: path.join(__dirname, 'notice_log.txt')
};

const CONFIG = {
  timeoutMs: 30000,
  maxRetries: 3,
  retryDelayMs: 1500,
  pdf: {
    format: 'A4',
    margin: {
      top: '10mm',
      right: '10mm',
      bottom: '10mm',
      left: '10mm'
    }
  }
};

function ensureFile(filePath, defaultContent = '') {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, defaultContent, 'utf8');
}

function normalize(v) {
  return String(v || '').trim();
}

function escapeHtml(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(FILES.log, line + '\n', 'utf8');
}

function parseLine(line) {
  return line.split('|').map(x => x.trim());
}

function loadPenaltyOutput() {
  const lines = fs.readFileSync(FILES.output, 'utf8')
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(line => !/^reg_no\s*\|/i.test(line));

  return lines.map(line => {
    const p = parseLine(line);
    return {
      reg_no: p[0],
      branch_code: p[1],
      penalized_subject_codes: normalize(p[2]).split(',').map(x => x.trim()).filter(Boolean),
      subject_names: normalize(p[3]).split(',').map(x => x.trim()).filter(Boolean),
      old_shown_grades: normalize(p[4]).split(',').map(x => x.trim()).filter(Boolean),
      new_shown_grades: normalize(p[5]).split(',').map(x => x.trim()).filter(Boolean),
      should_be_grades: normalize(p[6]).split(',').map(x => x.trim()).filter(Boolean),
      shown_sgpa: normalize(p[7]),
      corrected_sgpa: normalize(p[8]),
      shown_cgpa: normalize(p[9]),
      corrected_cgpa: normalize(p[10]),
      status: normalize(p[11]),
      old_result_url: normalize(p[12]),
      new_result_url: normalize(p[13])
    };
  });
}

function loadPenaltyAudit() {
  const lines = fs.readFileSync(FILES.audit, 'utf8')
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter(line => !/^reg_no\s*\|/i.test(line));

  const grouped = new Map();

  for (const line of lines) {
    const p = parseLine(line);
    const row = {
      reg_no: p[0],
      sem: p[1],
      branch_code: p[2],
      subject_code: p[3],
      subject_name: p[4],
      subject_type: p[5],
      credit: p[6],
      old_shown_grade: p[7],
      new_shown_grade: p[8],
      should_be_grade: p[9],
      shown_gp: p[10],
      corrected_gp: p[11],
      delta_points: p[12],
      new_ese: p[13],
      new_ia: p[14],
      new_total: p[15],
      old_result_url: p[16],
      new_result_url: p[17]
    };

    if (!grouped.has(row.reg_no)) grouped.set(row.reg_no, []);
    grouped.get(row.reg_no).push(row);
  }

  return grouped;
}

async function fetchWithRetries(url) {
  let delay = CONFIG.retryDelayMs;
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: CONFIG.timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'text/html,application/xhtml+xml,application/json'
        },
        validateStatus: status => status >= 200 && status < 500
      });

      if (response.status === 200) {
        return { kind: 'FOUND', data: response.data };
      }
      return { kind: 'NO_RECORD', error: `HTTP ${response.status}` };
    } catch (error) {
      if (attempt === CONFIG.maxRetries) {
        return { kind: 'ERROR', error: error.message };
      }
      await sleep(delay);
      delay *= 2;
    }
  }
  return { kind: 'ERROR', error: 'Unknown fetch error' };
}

function parseOldResultMetaAndSubjects(html) {
  const $ = cheerio.load(html);
  const meta = {
    student_name: normalize($('#ContentPlaceHolder1_DataList1_StudentNameLabel_0').text()),
    college_name: normalize($('#ContentPlaceHolder1_DataList1_CollegeNameLabel_0').text()),
    course_name: normalize($('#ContentPlaceHolder1_DataList1_CourseLabel_0').text()),
    exam_name: normalize($('#ContentPlaceHolder1_DataList4_Exam_Name_0').text()),
    semester: normalize($('#ContentPlaceHolder1_DataList2_Exam_Name_0').text()) || 'II',
    old_sgpa: normalize($('#ContentPlaceHolder1_DataList5_GROSSTHEORYTOTALLabel_0').text()) || '',
    old_cgpa: ''
  };

  $('#ContentPlaceHolder1_GridView3 tr:nth-child(2) td').each((index, cell) => {
    if (index === 8) meta.old_cgpa = normalize($(cell).text());
  });

  const rows = [];
  $('#ContentPlaceHolder1_GridView1 tr').slice(1).each((_, el) => {
    const cells = $(el).find('td');
    if (cells.length >= 7) {
      rows.push({
        subject_type: 'theory',
        subject_code: normalize($(cells[0]).text()),
        subject_name: normalize($(cells[1]).text()),
        ese: normalize($(cells[2]).text()),
        ia: normalize($(cells[3]).text()),
        total: normalize($(cells[4]).text()),
        grade: normalize($(cells[5]).text()),
        credit: normalize($(cells[6]).text())
      });
    }
  });
  $('#ContentPlaceHolder1_GridView2 tr').slice(1).each((_, el) => {
    const cells = $(el).find('td');
    if (cells.length >= 7) {
      rows.push({
        subject_type: 'practical',
        subject_code: normalize($(cells[0]).text()),
        subject_name: normalize($(cells[1]).text()),
        ese: normalize($(cells[2]).text()),
        ia: normalize($(cells[3]).text()),
        total: normalize($(cells[4]).text()),
        grade: normalize($(cells[5]).text()),
        credit: normalize($(cells[6]).text())
      });
    }
  });

  return { meta, rows };
}

function css() {
  return `
  @page { size: A4; margin: 10mm; }
  body { font-family: Arial, sans-serif; margin: 0; color: #111; }
  h1, h2, h3 { margin: 0 0 8px 0; }
  .page { page-break-after: always; border: 1px solid #ddd; padding: 16px; margin-bottom: 18px; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px; margin: 10px 0 16px; }
  .label { font-weight: 700; }
  .section-title { margin-top: 12px; font-size: 18px; border-bottom: 2px solid #333; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
  th, td { border: 1px solid #bbb; padding: 6px 8px; vertical-align: top; }
  th { background: #f2f2f2; }
  .row-flag { background: #fff6cc; }
  .oval-yellow { display: inline-block; padding: 2px 8px; border: 3px solid #f0c400; border-radius: 999px; font-weight: 700; background: #fffbe0; }
  .box-green { display: inline-block; padding: 2px 8px; border: 3px solid #188038; border-radius: 6px; font-weight: 700; background: #eef9ef; }
  .box-red { border: 3px solid #c5221f; background: #fff1f0; padding: 10px 12px; border-radius: 8px; margin-top: 12px; }
  .impact-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 16px; }
  .small { color: #555; font-size: 12px; word-break: break-all; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #eef2ff; border: 1px solid #99a3ff; }
  .kpi { display: inline-block; margin-right: 14px; margin-bottom: 8px; padding: 8px 12px; border-radius: 8px; background: #f6f8fa; border: 1px solid #ddd; }
  .mono { font-family: Consolas, monospace; }
  .front-page { page-break-after: always; padding: 8px 0 18px; }
  ul { margin-top: 6px; }
  `;
}

function makeStudentPage(student, auditRows, oldMeta, oldRows) {
  const codeSet = new Set(student.penalized_subject_codes);
  const oldFiltered = oldRows.filter(r => codeSet.has(r.subject_code));
  const sgpaDelta = (parseFloat(student.corrected_sgpa) - parseFloat(student.shown_sgpa)).toFixed(2);
  const cgpaDelta = (parseFloat(student.corrected_cgpa) - parseFloat(student.shown_cgpa)).toFixed(2);

  const oldTableRows = oldFiltered.map(r => `
    <tr class="row-flag">
      <td>${escapeHtml(r.subject_code)}</td>
      <td>${escapeHtml(r.subject_name)}</td>
      <td>${escapeHtml(r.ese)}</td>
      <td>${escapeHtml(r.ia)}</td>
      <td>${escapeHtml(r.total)}</td>
      <td><span class="oval-yellow">${escapeHtml(r.grade)}</span></td>
      <td>${escapeHtml(r.credit)}</td>
    </tr>
  `).join('');

  const newTableRows = auditRows.map(r => `
    <tr class="row-flag">
      <td>${escapeHtml(r.subject_code)}</td>
      <td>${escapeHtml(r.subject_name)}</td>
      <td>${escapeHtml(r.subject_type)}</td>
      <td>${escapeHtml(r.new_ese)}</td>
      <td>${escapeHtml(r.new_ia)}</td>
      <td>${escapeHtml(r.new_total)}</td>
      <td><span class="oval-yellow">${escapeHtml(r.new_shown_grade)}</span></td>
      <td><span class="box-green">${escapeHtml(r.should_be_grade)}</span></td>
      <td>${escapeHtml(r.credit)}</td>
      <td>${escapeHtml(r.delta_points)}</td>
    </tr>
  `).join('');

  return `
  <div class="page">
    <h2>Penalty Notice Case</h2>
    <div class="meta-grid">
      <div><span class="label">Registration No:</span> <span class="mono">${escapeHtml(student.reg_no)}</span></div>
      <div><span class="label">Branch Code:</span> ${escapeHtml(student.branch_code)}</div>
      <div><span class="label">Student Name:</span> ${escapeHtml(oldMeta.student_name || '-')}</div>
      <div><span class="label">Course:</span> ${escapeHtml(oldMeta.course_name || '-')}</div>
      <div><span class="label">College:</span> ${escapeHtml(oldMeta.college_name || '-')}</div>
      <div><span class="label">Status:</span> <span class="pill">${escapeHtml(student.status)}</span></div>
    </div>

    <div class="section-title">Old Result: Faulty Subject(s)</div>
    <table>
      <thead>
        <tr>
          <th>Subject Code</th>
          <th>Subject Name</th>
          <th>ESE</th>
          <th>IA</th>
          <th>Total</th>
          <th>Old Shown Grade</th>
          <th>Credit</th>
        </tr>
      </thead>
      <tbody>${oldTableRows || '<tr><td colspan="7">Old subject row not available.</td></tr>'}</tbody>
    </table>

    <div class="section-title">New Published Result vs Real Grade</div>
    <table>
      <thead>
        <tr>
          <th>Subject Code</th>
          <th>Subject Name</th>
          <th>Type</th>
          <th>New ESE</th>
          <th>New IA</th>
          <th>New Total</th>
          <th>New Shown Grade</th>
          <th>Real Grade</th>
          <th>Credit</th>
          <th>Delta Points</th>
        </tr>
      </thead>
      <tbody>${newTableRows}</tbody>
    </table>

    <div class="box-red">
      <h3>Impact on SGPA / Current CGPA</h3>
      <div class="impact-grid">
        <div><span class="label">Shown SGPA:</span> <span class="oval-yellow">${escapeHtml(student.shown_sgpa)}</span></div>
        <div><span class="label">Corrected SGPA:</span> <span class="box-green">${escapeHtml(student.corrected_sgpa)}</span></div>
        <div><span class="label">Shown Current CGPA:</span> <span class="oval-yellow">${escapeHtml(student.shown_cgpa)}</span></div>
        <div><span class="label">Corrected Current CGPA:</span> <span class="box-green">${escapeHtml(student.corrected_cgpa)}</span></div>
        <div><span class="label">SGPA Increase:</span> ${escapeHtml(sgpaDelta)}</div>
        <div><span class="label">CGPA Increase:</span> ${escapeHtml(cgpaDelta)}</div>
      </div>
    </div>

    <p class="small">Old Result URL: ${escapeHtml(student.old_result_url)}</p>
    <p class="small">New Result URL: ${escapeHtml(student.new_result_url)}</p>
  </div>`;
}

function buildSummaryHtml(students, auditMap) {
  const totalStudents = students.length;
  const totalSubjects = Array.from(auditMap.values()).reduce((a, rows) => a + rows.length, 0);
  const branchCounts = new Map();
  const subjectCounts = new Map();
  let theory = 0;
  let practical = 0;
  let maxSgpa = -Infinity;
  let maxCgpa = -Infinity;
  let maxSgpaReg = '';
  let maxCgpaReg = '';

  for (const s of students) {
    branchCounts.set(s.branch_code, (branchCounts.get(s.branch_code) || 0) + 1);
    const sg = parseFloat(s.corrected_sgpa) - parseFloat(s.shown_sgpa);
    const cg = parseFloat(s.corrected_cgpa) - parseFloat(s.shown_cgpa);
    if (sg > maxSgpa) { maxSgpa = sg; maxSgpaReg = s.reg_no; }
    if (cg > maxCgpa) { maxCgpa = cg; maxCgpaReg = s.reg_no; }
  }

  for (const rows of auditMap.values()) {
    for (const r of rows) {
      if (r.subject_type === 'practical') practical += 1; else theory += 1;
      subjectCounts.set(r.subject_code, (subjectCounts.get(r.subject_code) || 0) + 1);
    }
  }

  const topBranches = Array.from(branchCounts.entries()).sort((a,b)=>b[1]-a[1]).slice(0,10)
    .map(([k,v]) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join('');
  const topSubjects = Array.from(subjectCounts.entries()).sort((a,b)=>b[1]-a[1]).slice(0,10)
    .map(([k,v]) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Penalty Summary</title><style>${css()}</style></head><body>
    <div class="front-page">
      <h1>BEU Penalty Summary</h1>
      <div class="kpi"><b>Total Students</b><br>${totalStudents}</div>
      <div class="kpi"><b>Total Penalized Subject Rows</b><br>${totalSubjects}</div>
      <div class="kpi"><b>Theory Rows</b><br>${theory}</div>
      <div class="kpi"><b>Practical Rows</b><br>${practical}</div>
      <div class="kpi"><b>Max SGPA Increase</b><br>${maxSgpa.toFixed(2)} (${escapeHtml(maxSgpaReg)})</div>
      <div class="kpi"><b>Max CGPA Increase</b><br>${maxCgpa.toFixed(2)} (${escapeHtml(maxCgpaReg)})</div>

      <h2>Top Branches</h2>
      <table><thead><tr><th>Branch Code</th><th>Student Count</th></tr></thead><tbody>${topBranches}</tbody></table>

      <h2>Top Penalized Subject Codes</h2>
      <table><thead><tr><th>Subject Code</th><th>Count</th></tr></thead><tbody>${topSubjects}</tbody></table>
    </div>
  </body></html>`;
}

function buildPriorityHtml(students, auditMap) {
  const rows = [];
  for (const s of students) {
    const subjectCount = (auditMap.get(s.reg_no) || []).length;
    const sg = parseFloat(s.corrected_sgpa) - parseFloat(s.shown_sgpa);
    const cg = parseFloat(s.corrected_cgpa) - parseFloat(s.shown_cgpa);
    if (subjectCount >= 3 || sg >= 0.40 || cg >= 0.15) {
      rows.push({ ...s, subjectCount, sg, cg });
    }
  }

  rows.sort((a,b) => (b.subjectCount - a.subjectCount) || (b.sg - a.sg) || (b.cg - a.cg));

  const tr = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.reg_no)}</td>
      <td>${escapeHtml(r.branch_code)}</td>
      <td>${r.subjectCount}</td>
      <td>${r.sg.toFixed(2)}</td>
      <td>${r.cg.toFixed(2)}</td>
      <td>${escapeHtml(r.penalized_subject_codes.join(','))}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Priority Cases</title><style>${css()}</style></head><body>
    <div class="front-page">
      <h1>Priority Penalty Cases</h1>
      <p class="small">Students with 3+ penalized subjects or large SGPA/CGPA impact.</p>
      <table>
        <thead><tr><th>Reg No</th><th>Branch</th><th>Subject Count</th><th>SGPA Increase</th><th>CGPA Increase</th><th>Subject Codes</th></tr></thead>
        <tbody>${tr}</tbody>
      </table>
    </div>
  </body></html>`;
}

async function renderPdf(htmlPath, pdfPath) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
    await page.pdf({ path: pdfPath, printBackground: true, format: CONFIG.pdf.format, margin: CONFIG.pdf.margin });
  } finally {
    await browser.close();
  }
}

async function run() {
  ensureFile(FILES.log, '');
  ensureFile(FILES.failed, 'reg_no | issue | details\n');
  ensureFile(FILES.manifest, 'section | count\n');

  const students = loadPenaltyOutput();
  const auditMap = loadPenaltyAudit();

  const summaryHtml = buildSummaryHtml(students, auditMap);
  const priorityHtml = buildPriorityHtml(students, auditMap);

  const oldCache = new Map();
  let body = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>All Notices</title><style>${css()}</style></head><body>`;
  body += buildSummaryHtml(students, auditMap).replace(/^<!DOCTYPE html><html><head><meta charset="utf-8"><title>Penalty Summary<\/title><style>[\s\S]*?<\/style><\/head><body>/, '').replace(/<\/body><\/html>$/, '');
  body += buildPriorityHtml(students, auditMap).replace(/^<!DOCTYPE html><html><head><meta charset="utf-8"><title>Priority Cases<\/title><style>[\s\S]*?<\/style><\/head><body>/, '').replace(/<\/body><\/html>$/, '');

  for (let i = 0; i < students.length; i++) {
    const student = students[i];
    const auditRows = auditMap.get(student.reg_no) || [];
    if (!auditRows.length) {
      fs.appendFileSync(FILES.failed, `${student.reg_no} | AUDIT_MISSING | no audit rows found\n`, 'utf8');
      continue;
    }

    let oldMeta = { student_name: '', college_name: '', course_name: '' };
    let oldRows = [];

    if (oldCache.has(student.old_result_url)) {
      ({ meta: oldMeta, rows: oldRows } = oldCache.get(student.old_result_url));
    } else {
      const fetched = await fetchWithRetries(student.old_result_url);
      if (fetched.kind !== 'FOUND') {
        fs.appendFileSync(FILES.failed, `${student.reg_no} | OLD_FETCH_FAIL | ${fetched.error || fetched.kind}\n`, 'utf8');
      } else {
        const parsed = parseOldResultMetaAndSubjects(fetched.data);
        oldMeta = parsed.meta;
        oldRows = parsed.rows;
        oldCache.set(student.old_result_url, parsed);
      }
    }

    body += makeStudentPage(student, auditRows, oldMeta, oldRows);
    if ((i + 1) % 50 === 0) log(`BUILT ${i + 1}/${students.length} notices`);
  }

  body += '</body></html>';
  fs.writeFileSync(FILES.summaryHtml, summaryHtml, 'utf8');
  fs.writeFileSync(FILES.priorityHtml, priorityHtml, 'utf8');
  fs.writeFileSync(FILES.allHtml, body, 'utf8');
  fs.writeFileSync(FILES.manifest, `section | count\nsummary | 1\npriority | 1\nstudent_notices | ${students.length}\n`, 'utf8');

  log('HTML files written. Starting PDF render...');
  await renderPdf(FILES.allHtml, FILES.allPdf);
  log('COMPLETE wrote all_notices.html and all_notices.pdf');
}

run().catch(err => {
  log(`FATAL ${err.stack || err.message}`);
  process.exit(1);
});
