// /api/answer.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function safeJsonParse(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// 모델이 JSON 앞뒤로 말 붙이는 경우를 대비해 JSON 객체만 추출
function extractFirstJsonObject(text) {
  if (!text) return null;
  const s = text.trim();

  // 이미 JSON이면
  const direct = safeJsonParse(s, null);
  if (direct && typeof direct === "object") return direct;

  // 첫 '{'부터 마지막 '}'까지 잘라서 시도
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const chunk = s.slice(first, last + 1);
    const obj = safeJsonParse(chunk, null);
    if (obj && typeof obj === "object") return obj;
  }
  return null;
}

function normalizeAnswer(obj, userText = "") {
  const out = {
    summary: "",
    top3: ["", "", ""],
    action: "",
    nextQuestion: "",
    evidenceType: "",
    redFlag: "",
    meta: {
      version: "answer-json-v1",
      lang: "ko",
      missing: []
    }
  };

  if (!obj || typeof obj !== "object") {
    out.summary = "정보가 부족해 우선 핵심만 정리할게.";
    out.top3 = ["정보부족", "정보부족", "정보부족"];
    out.action = "현재 증상/목표를 한 문장으로 적어줘.";
    out.nextQuestion = "지금 가장 불편한 증상이나 목표를 한 문장으로 말해줄래?";
    out.evidenceType = "사용자입력";
    out.redFlag = "뚜렷한 위험신호 없음";
    out.meta.missing.push("all");
    return out;
  }

  const pickStr = (v) => (typeof v === "string" ? v.trim() : "");
  const pickArr3 = (v) => {
    if (Array.isArray(v)) {
      const a = v.map(x => pickStr(x)).filter(Boolean);
      return [a[0] || "", a[1] || "", a[2] || ""];
    }
    if (typeof v === "string") {
      const parts = v.split(",").map(s => s.trim()).filter(Boolean);
      return [parts[0] || "", parts[1] || "", parts[2] || ""];
    }
    return ["", "", ""];
  };

  out.summary = pickStr(obj.summary);
  out.top3 = pickArr3(obj.top3);
  out.action = pickStr(obj.action);
  out.nextQuestion = pickStr(obj.nextQuestion);
  out.evidenceType = pickStr(obj.evidenceType);
  out.redFlag = pickStr(obj.redFlag);

  // 최소 보정
  if (!out.summary) out.meta.missing.push("summary");
  if (!out.top3.some(Boolean)) out.meta.missing.push("top3");
  if (!out.action) out.meta.missing.push("action");
  if (!out.nextQuestion) out.meta.missing.push("nextQuestion");
  if (!out.evidenceType) out.meta.missing.push("evidenceType");
  if (!out.redFlag) out.meta.missing.push("redFlag");

  // nextQuestion는 질문 1개로 강제
  if (out.nextQuestion && !out.nextQuestion.endsWith("?")) out.nextQuestion += "?";
  // top3 빈칸 채우기
  for (let i = 0; i < 3; i++) if (!out.top3[i]) out.top3[i] = "정보부족";

  // redFlag 기본값
  if (!out.redFlag) out.redFlag = "뚜렷한 위험신호 없음";

  // 극단적으로 다 비어있을 때 대비
  if (out.meta.missing.length >= 5) {
    out.summary = out.summary || "정보가 부족해 우선 정리할게.";
    out.action = out.action || "지금 상태를 한 문장으로 적어줘.";
    out.nextQuestion = out.nextQuestion || "가장 불편한 증상/목표가 뭐야?";
    out.evidenceType = out.evidenceType || "사용자입력";
    out.redFlag = out.redFlag || "뚜렷한 위험신호 없음";
  }

  return out;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = typeof req.body === "string" ? safeJsonParse(req.body, {}) : (req.body || {});
    const mode = (body.mode || "counsel").toString(); // "counsel" | "mybody"
    const userText = (body.text || "").toString().trim();
    const turns = Array.isArray(body.turns) ? body.turns.slice(-12) : []; // [{q,aJson}] or {q,aHtml} etc
    const myBody = body.myBody || {};

    if (!userText) return res.status(400).json({ error: "Missing text" });

    const system = [
      "너는 ANSWER 프로젝트의 상담(Home)+My Body 통합 MVP 응답 엔진이다.",
      "반드시 JSON 객체 1개만 출력한다. 다른 글(설명/인사/마크다운/코드펜스) 절대 금지.",
      "스키마:",
      "{",
      '  "summary": string,',
      '  "top3": [string, string, string],',
      '  "action": string,',
      '  "nextQuestion": string,',
      '  "evidenceType": string,',
      '  "redFlag": string',
      "}",
      "규칙:",
      "- summary: 핵심요약 1문장(짧게).",
      "- top3: 가능성 3개만(각 항목 짧게).",
      "- action: 지금 당장 할 행동 1가지(구체적으로).",
      "- nextQuestion: 다음 질문은 1개만, 물음표로 끝내기.",
      "- evidenceType: 근거 타입만 짧게(예: 연구, 가이드라인, 전문가합의, 일반생리, 사용자입력).",
      "- redFlag: 레드플래그 짧게 나열. 없으면 '뚜렷한 위험신호 없음'.",
      "의학/법/투자 등 민감주제라도 안전문구를 반복하지 말고 위 JSON만 출력.",
      "정보가 부족하면 '정보부족'을 사용하고 nextQuestion으로 필요한 정보 1개만 요청."
    ].join("\n");

    const context = [
      `mode=${mode}`,
      "turns:",
      JSON.stringify(turns).slice(0, 2000),
      "myBody:",
      JSON.stringify(myBody).slice(0, 2000),
      "user:",
      userText
    ].join("\n");

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-5",
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: context }
      ],
    });

    const raw = (completion.choices?.[0]?.message?.content || "").trim();
    const obj = extractFirstJsonObject(raw);
    const answer = normalizeAnswer(obj, userText);

    return res.status(200).json({ answer });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
