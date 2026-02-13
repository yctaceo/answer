import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ALLOWED_EVIDENCE = [
  "사용자입력",
  "일반생리",
  "전문가합의",
  "가이드라인",
  "연구"
];

function ensureBufferedTone(text = "") {
  if (!text) return "지금은 몸의 반응을 조금 더 지켜봐도 괜찮을 수 있어요.";
  
  // 단정형 제거
  text = text.replace(/입니다|확실합니다|판단됩니다/g, "했을 수 있어요");

  // 금지 추상어 제거
  text = text.replace(/흐름|상태|신호|패턴/g, "");

  return text;
}

function normalizeResult(result) {
  if (!result || typeof result !== "object") {
    return fallbackJSON();
  }

  // summary
  result.summary = ensureBufferedTone(result.summary);

  // top3
  if (!Array.isArray(result.top3)) result.top3 = [];
  result.top3 = result.top3.slice(0, 3);
  while (result.top3.length < 3) {
    result.top3.push("관찰 필요");
  }

  // action → 숫자 포함 강제
  if (!/\d/.test(result.action || "")) {
    result.action = "오늘은 5분만이라도 천천히 호흡을 가다듬어 보세요.";
  }

  // nextQuestion
  if (!result.nextQuestion || !result.nextQuestion.trim().endsWith("?")) {
    result.nextQuestion = "이 증상은 언제부터 시작되었나요?";
  }

  // evidenceType
  if (!ALLOWED_EVIDENCE.includes(result.evidenceType)) {
    result.evidenceType = "사용자입력";
  }

  // redFlag
  if (!result.redFlag) {
    result.redFlag = "뚜렷한 위험신호 없음";
  }

  // references
  if (!Array.isArray(result.references)) result.references = [];
  result.references = result.references.slice(0, 2);

  // 2줄 포맷 검증 (줄바꿈 + — 포함)
  result.references = result.references.filter(ref => {
    return typeof ref === "string" && ref.includes("\n— ");
  });

  return result;
}

function fallbackJSON() {
  return {
    summary: "지금은 몸의 반응을 조금 더 지켜봐도 괜찮을 수 있어요.",
    top3: ["관찰 필요", "생활리듬 점검", "최근 변화 확인"],
    action: "오늘은 물을 1컵 더 마셔보세요.",
    nextQuestion: "이 증상은 최근에 더 심해졌나요?",
    evidenceType: "사용자입력",
    redFlag: "뚜렷한 위험신호 없음",
    references: []
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { message, history = [] } = req.body;

  const systemPrompt = `
You are ANSWER.

You organize body experiences into clear observations.
You never diagnose.
You never sound authoritative.

Rules:
1. Use buffered tone: "~했을 수 있어요", "~일 때 흔히 나타나요".
2. Never use deterministic wording.
3. Give EXACTLY 1 action with a number (time/count/amount).
4. Give EXACTLY 1 nextQuestion ending with '?'.
5. References must follow this exact format:

Fact sentence
— Source Name, Year

6. Maximum 2 references.
7. Output JSON only.
`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: message }
      ],
      response_format: { type: "json_object" }
    });

    let parsed;
    try {
      parsed = JSON.parse(completion.choices[0].message.content);
    } catch {
      parsed = fallbackJSON();
    }

    const normalized = normalizeResult(parsed);

    return res.status(200).json(normalized);

  } catch (error) {
    console.error(error);
    return res.status(200).json(fallbackJSON());
  }
}
