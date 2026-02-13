// api/answer.js  (CommonJS for Vercel Node runtime)

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function toStr(x, fallback = "") {
  return typeof x === "string" ? x : fallback;
}

function toStrArray(x, fallback = []) {
  return Array.isArray(x) ? x.map(v => (typeof v === "string" ? v : "")).filter(Boolean) : fallback;
}

/**
 * references 포맷 강제:
 * "문장"
 * "— Source, Year"
 */
function normalizeReferences(refs) {
  const arr = toStrArray(refs, []);
  const normalized = arr.slice(0, 3).map((r) => {
    const s = String(r || "").trim();

    // "Fact -- Source, Year" 형태면 줄바꿈 + em dash로 변환
    if (s.includes(" -- ")) {
      const [a, b] = s.split(" -- ");
      return `${a.trim()}\n— ${String(b || "").trim()}`;
    }

    // 이미 "—"가 있으면, 없으면 임시로 한 줄 처리
    if (s.includes("\n—")) return s;

    // 한 줄만 들어온 경우: 그래도 2줄 형태로 만들기(출처가 없으면 "— User-provided"로라도)
    // (원하면 여기에서 "— Source, Year" 없으면 빈칸으로 두도록 바꿔도 됨)
    if (s.startsWith("—")) return `참고 내용\n${s}`;
    return `${s}\n— User-provided`;
  });

  return normalized;
}

function normalizeAnswer(obj) {
  const answer = obj && typeof obj === "object" ? obj : {};

  const summary = toStr(answer.summary, "").trim();
  const top3 = toStrArray(answer.top3, []).slice(0, 3);
  const action = toStr(answer.action, "").trim();
  const nextQuestion = toStr(answer.nextQuestion, "").trim();
  const evidenceType = toStr(answer.evidenceType, "사용자입력").trim();
  const redFlag = toStr(answer.redFlag, "뚜렷한 위험신호 없음").trim();
  const references = normalizeReferences(answer.references);

  return {
    summary: summary || "정보가 부족해. 지금 보이는 신호만 짧게 정리해볼게.",
    top3: top3.length ? top3 : ["정보부족", "정보부족", "정보부족"],
    action: action || "지금 상태를 ‘언제부터/어디가/어떻게’ 1문장으로 적어줘.",
    nextQuestion: nextQuestion || "이 증상은 언제부터 시작됐어?",
    evidenceType: evidenceType || "사용자입력",
    redFlag: redFlag || "뚜렷한 위험신호 없음",
    references,
    meta: {
      version: "answer-json-v1.1.2",
      lang: "ko",
    },
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // index.html에서 보내는 payloadAnswer: { mode, text, turns, myBody }
  const body = req.body || {};
  const userText = typeof body.text === "string" ? body.text.trim() : "";
  const turns = Array.isArray(body.turns) ? body.turns : [];

  if (!userText) {
    return res.status(400).json({ error: "Missing text" });
  }

  // turns: [{ q, aJson }] 형태를 messages로 변환(최대 몇 개만)
  const historyMessages = [];
  for (const t of turns.slice(-6)) {
    if (t && typeof t === "object") {
      if (typeof t.q === "string" && t.q.trim()) {
        historyMessages.push({ role: "user", content: t.q.trim() });
      }
      // aJson이 객체/문자열 둘 다 가능
      if (t.aJson) {
        const a =
          typeof t.aJson === "string"
            ? t.aJson
            : JSON.stringify(t.aJson);
        historyMessages.push({ role: "assistant", content: a });
      }
    }
  }

  const system = [
    "너는 ANSWER 프로젝트의 상담(Home)+My Body 통합 MVP 응답 엔진이다.",
    "",
    "핵심 목표:",
    "- 사용자의 ‘몸 신호’를 관찰 → 연결 → 다음 행동으로 이어지게 한다.",
    "- 진단/처방/단정 금지. 대신 ‘가능성’과 ‘관찰 기반 제안’으로 말한다.",
    "",
    "절대 규칙:",
    "1) 반드시 JSON 객체 1개만 출력한다. 다른 글(설명/인사/마크다운/코드블록) 절대 금지.",
    "2) 사용자가 말하지 않은 ‘증상’을 새로 만들어내지 않는다. (예: 가렵지 않다 했으면 ‘가려움’ 언급 금지)",
    "3) top3는 ‘증상’이 아니라 ‘가능성(원인 가설/상황 가설)’로 작성한다. (짧게 2~6단어)",
    "4) action은 ‘지금 할 1가지’만. 하지만 한 문장 안에서 충분히 구체적으로 써라. (빈도/타이밍/양 포함)",
    "5) nextQuestion은 질문 1개만. 마지막은 반드시 '?' 로 끝낸다.",
    "6) references는 2개 권장(최대 3개). 각 항목은 반드시 2줄 형식:",
    "   첫 줄: 사실/근거 문장",
    "   둘째 줄: — 저널/가이드라인/기관, 연도",
    "",
    "출력 스키마(반드시 이 키만):",
    "{",
    '  "summary": "string",',
    '  "top3": ["string","string","string"],',
    '  "action": "string",',
    '  "nextQuestion": "string",',
    '  "evidenceType": "string",',
    '  "redFlag": "string",',
    '  "references": ["string","string"],',
    '  "meta": {"version":"string","lang":"string"}',
    "}",
  ].join("\n");

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        ...historyMessages,
        { role: "user", content: userText },
      ],
      // JSON only 강제
      response_format: { type: "json_object" },
      temperature: 0.4,
    });

    const raw = response?.choices?.[0]?.message?.content || "";
    const parsed = safeJsonParse(raw);

    const normalized = normalizeAnswer(parsed);

    // ✅ 여기서 "객체"로 내려줘야 index.html이 카드 렌더링 함
    return res.status(200).json({ answer: normalized });
  } catch (err) {
    console.error("ANSWER API error:", err);

    // fallback도 동일 스키마 "객체"로
    return res.status(200).json({
      answer: normalizeAnswer({
        summary: "서버 연결이 잠시 불안정해. 지금은 기본 흐름으로만 안내할게.",
        top3: ["연결 오류", "일시 장애", "재시도 필요"],
        action: "30초 뒤에 같은 문장을 한 번만 다시 보내줘.",
        nextQuestion: "지금 가장 불편한 증상이 ‘언제부터’ 시작됐어?",
        evidenceType: "시스템",
        redFlag: "뚜렷한 위험신호 없음",
        references: [],
      }),
    });
  }
};
