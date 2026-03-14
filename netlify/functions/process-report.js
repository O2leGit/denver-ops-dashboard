const Anthropic = require("@anthropic-ai/sdk");

const EXTRACTION_PROMPT = `You are a data extraction assistant for a Denver Operations Recovery Dashboard at Bio-Techne/Novus Biologicals.

Extract structured data from the daily operations report below. Return ONLY valid JSON matching this exact schema (no markdown, no code fences, just raw JSON):

{
  "meta": {
    "reportDate": "YYYY-MM-DD format",
    "dataPull": "Mon DD, H:MM AM/PM CT format",
    "week": "Week N",
    "planPhase": "WEEK N TRIAGE PLAN",
    "reportRef": "M/DD/YY Reporting",
    "footerDate": "Month DD, YYYY",
    "stockPrice": "$XX.XX"
  },
  "kpis": {
    "shippedYesterday": { "value": "$X,XXX", "date": "M/DD", "target": "$X,XXX", "status": "On Track|Underperform|At Risk|Optimal" },
    "mtdOTD": { "value": "XX.X%", "target": "95.0%", "status": "..." },
    "currentBacklog": { "value": "$X,XXX,XXX", "target": "$900,000", "status": "..." },
    "netDailyBurn": { "value": "$XX.XK", "consecutiveDays": N, "status": "..." }
  },
  "recoveryBridge": {
    "siteBacklog": "$X,XXX,XXX",
    "oemConversion": { "reduction": "-$XXX,XXX", "totalSegment": "$XXX,XXX", "barWidth": "XX%" },
    "supplierInTransit": { "reduction": "-$XXX,XXX", "barWidth": "XX%" },
    "labConfirmed": { "reduction": "-$XX,XXX", "barWidth": "X%" },
    "intakeForecast": { "addition": "+$XXX,XXX", "barWidth": "XX%" },
    "projectedClosing": "$XXX,XXX",
    "forecastStatus": "Projected Miss|On Track",
    "missAmount": "$XX,XXX",
    "closingBarWidth": "XX%"
  },
  "operationalHealth": {
    "workforceReadiness": { "pct": N, "note": "short note" },
    "labCapacity": { "pct": N, "note": "short note" },
    "warehouseEfficiency": { "pct": N, "note": "short note" }
  },
  "supplierCriticalPath": [
    { "name": "Supplier", "status": "Delayed|Critical|At Risk|On Track", "statusColor": "rose|amber|emerald", "timeline": "short timeline", "detail": "brief detail" }
  ],
  "narrative": {
    "quote": "Nicole's summary narrative (1-3 sentences)",
    "operationalRealities": [
      { "title": "Short Title", "detail": "Brief description" }
    ],
    "strategyUpdates": ["Strategy update paragraph 1", "Strategy update paragraph 2"]
  },
  "actionItems": [
    {
      "task": "Action item description",
      "owner": "Person Name",
      "impact": "Display label (e.g. OTD Accur., Efficiency, Backlog)",
      "impactType": "otd|backlog|unknown",
      "deadline": "MAR DD or MAR DD EOD/MID",
      "status": "Pending|Completed",
      "tag": "New (M/DD)|In Progress|Strategic Priority|Carryover",
      "tagType": "new|carryover",
      "priority": false
    }
  ],
  "history": []
}

IMPORTANT RULES:
- If a data point isn't in the report, use reasonable defaults or keep previous values.
- The "history" array should be EMPTY - the server will manage history by shifting current data.
- Status values: "On Track" (green), "At Risk"/"Underperform"/"Critical" (red), "Optimal" (green).
- statusColor: use "rose" for Delayed/Critical, "amber" for At Risk, "emerald" for On Track.
- barWidth: calculate as approximate percentage of the siteBacklog value.
- closingBarWidth: projectedClosing / siteBacklog * 100, capped at 100%.
- For stockPrice, use the most recent known value ($53.89) if not in the report.
- Extract the narrative quote as a concise 1-3 sentence summary in Nicole's voice.
- Mark action items with the highest strategic importance as priority: true.

REPORT TEXT:
`;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO;

  // Handle auth check
  const contentType = event.headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    try {
      const body = JSON.parse(event.body);
      if (body.action === "auth") {
        if (body.password === ADMIN_PASSWORD) {
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
        }
        return { statusCode: 401, headers, body: JSON.stringify({ error: "Invalid password" }) };
      }
    } catch (e) {
      // Not JSON auth, continue
    }
  }

  // Handle file upload (multipart form data)
  try {
    const { password, fileContent, fileName } = parseMultipart(event);

    // Verify password
    if (password !== ADMIN_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    // Extract text from file
    let reportText;
    if (fileName.toLowerCase().endsWith(".pdf")) {
      const pdfParse = require("pdf-parse");
      const buffer = Buffer.from(fileContent, "binary");
      const pdfData = await pdfParse(buffer);
      reportText = pdfData.text;
    } else {
      const mammoth = require("mammoth");
      const buffer = Buffer.from(fileContent, "binary");
      const result = await mammoth.extractRawText({ buffer });
      reportText = result.value;
    }

    if (!reportText || reportText.trim().length < 50) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Could not extract text from file. File may be empty or corrupted." }) };
    }

    // Call Claude API to extract structured data
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [
        { role: "user", content: EXTRACTION_PROMPT + reportText }
      ],
    });

    const aiResponse = message.content[0].text.trim();
    let extractedData;
    try {
      extractedData = JSON.parse(aiResponse);
    } catch (e) {
      // Try to find JSON in the response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[0]);
      } else {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "AI returned invalid JSON. Please try again." }) };
      }
    }

    // Get current dashboard data from GitHub to merge history
    const currentData = await getGitHubFile(GITHUB_TOKEN, GITHUB_REPO, "data/dashboard-data.json");
    let currentJson = {};
    if (currentData) {
      currentJson = JSON.parse(Buffer.from(currentData.content, "base64").toString("utf-8"));
    }

    // Merge: shift current KPIs into history, apply new data
    if (currentJson.kpis && currentJson.meta) {
      const todayHistory = {
        date: formatHistoryDate(currentJson.meta.reportDate),
        label: null,
        shipped: abbreviateValue(currentJson.kpis.shippedYesterday.value),
        mtdOTD: currentJson.kpis.mtdOTD.value,
        health: calculateHealth(currentJson.operationalHealth),
        backlogChange: calculateBacklogChange(currentJson, extractedData),
        backlogDirection: "down",
      };

      // Prepend current data as latest history entry, keep max 5
      const existingHistory = currentJson.history || [];
      extractedData.history = [todayHistory, ...existingHistory].slice(0, 5);
      if (extractedData.history.length > 0) {
        extractedData.history[0].label = "Latest";
        for (let i = 1; i < extractedData.history.length; i++) {
          extractedData.history[i].label = null;
        }
      }
    }

    // Commit updated data to GitHub
    const newContent = Buffer.from(JSON.stringify(extractedData, null, 2)).toString("base64");
    await updateGitHubFile(
      GITHUB_TOKEN,
      GITHUB_REPO,
      "data/dashboard-data.json",
      newContent,
      `Update dashboard data from ${fileName}`,
      currentData ? currentData.sha : null
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, data: extractedData }),
    };

  } catch (err) {
    console.error("Processing error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || "Internal server error" }),
    };
  }
};

// ── Multipart Parser ──
function parseMultipart(event) {
  const boundary = (event.headers["content-type"] || "").split("boundary=")[1];
  if (!boundary) throw new Error("No multipart boundary found");

  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("binary")
    : event.body;

  const parts = body.split("--" + boundary);
  let password = "";
  let fileContent = "";
  let fileName = "";

  for (const part of parts) {
    if (part.includes('name="password"')) {
      password = part.split("\r\n\r\n")[1].split("\r\n")[0].trim();
    }
    if (part.includes('name="file"')) {
      const filenameMatch = part.match(/filename="([^"]+)"/);
      if (filenameMatch) fileName = filenameMatch[1];
      const contentStart = part.indexOf("\r\n\r\n") + 4;
      const contentEnd = part.lastIndexOf("\r\n");
      fileContent = part.substring(contentStart, contentEnd);
    }
  }

  return { password, fileContent, fileName };
}

// ── GitHub API Helpers ──
async function getGitHubFile(token, repo, path) {
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function updateGitHubFile(token, repo, path, content, message, sha) {
  const body = { message, content, branch: "master" };
  if (sha) body.sha = sha;

  const resp = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`GitHub commit failed: ${err.message}`);
  }
  return await resp.json();
}

// ── Utility Functions ──
function formatHistoryDate(dateStr) {
  if (!dateStr) return "Unknown";
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function abbreviateValue(val) {
  if (!val) return "$0";
  const num = parseFloat(val.replace(/[$,]/g, ""));
  if (num >= 1000) return "$" + (num / 1000).toFixed(1) + "K";
  return val;
}

function calculateHealth(health) {
  if (!health) return "N/A";
  const avg = Math.round(
    (health.workforceReadiness.pct + health.labCapacity.pct + health.warehouseEfficiency.pct) / 3
  );
  return avg + "%";
}

function calculateBacklogChange(oldData, newData) {
  try {
    const oldVal = parseFloat(oldData.kpis.currentBacklog.value.replace(/[$,]/g, ""));
    const newVal = parseFloat(newData.kpis.currentBacklog.value.replace(/[$,]/g, ""));
    const diff = newVal - oldVal;
    const sign = diff <= 0 ? "-" : "+";
    return sign + "$" + (Math.abs(diff) / 1000).toFixed(1) + "K";
  } catch {
    return "$0K";
  }
}
