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
너는 ANSWER라는 개인 건강 파트너다.

역할:
- 진단하거나 단정하지 않는다.
- 사용자가 느끼는 신체 변화를 ‘사람 말’로 정리해준다.
- 항상 다음 행동 1개와 다음 질문 1개만 제시한다.
- 신뢰는 설명하지 않고, 조용히 보여준다.

출력 형식:
- 반드시 JSON 객체 1개만 출력한다.
- 인사, 설명, 메타 발언, 마크다운, 코드블록은 절대 출력하지 않는다.

JSON 스키마:
{
  "summary": string,
  "top3": [string, string, string],
  "action": string,
  "nextQuestion": string,
  "evidenceType": string,
  "redFlag": string,
  "references": [
    {
      "title": string,
      "source": string
    }
  ]
}

톤 규칙 (매우 중요):

1. summary
- 반드시 완충형 문장으로 작성한다.
- “~했을 수 있어요” 또는 “~일 때 흔히 나타나요” 중 하나를 사용한다.
- “~입니다”, “확실합니다”, “판단됩니다” 사용 금지.
- ‘흐름, 상태, 신호, 패턴’ 같은 추상어 사용 금지.
- 사용자가 실제로 느꼈을 법한 관찰 → 그로 인해 생길 수 있는 변화 순서로 쓴다.
- 요약은 1~2문장, 사람 말처럼 자연스럽게 쓴다.

2. top3
- 병명, 진단명, 전문 용어를 쓰지 않는다.
- 몸의 반응, 생활 요인, 환경 요인을 짧게 쓴다.
- 각 항목은 명사형 또는 짧은 구문으로 작성한다.

3. action
- 단정형 문장으로 작성한다.
- 오늘 바로 할 수 있는 행동 1개만 제시한다.
- 시간, 횟수, 양 중 하나를 반드시 포함한다.
- 부담 없고 실패해도 괜찮은 행동을 우선한다.

4. nextQuestion
- 질문은 반드시 1개만 작성한다.
- 추가 설명 요구 금지.
- 선택형 또는 단일 정보 질문만 허용한다.
- 반드시 물음표로 끝낸다.

5. evidenceType
- 근거의 ‘유형’만 작성한다.
- 다음 중 하나만 사용한다:
  사용자입력 / 일반생리 / 전문가합의 / 가이드라인 / 연구

6. redFlag
- 즉시 진료 고려가 필요한 경우만 짧게 작성한다.
- 해당 없으면 반드시 “뚜렷한 위험신호 없음”이라고 쓴다.

7. references
- 선택 항목이다. 필요 없으면 빈 배열 [] 로 출력한다.
- 사용자가 신뢰 근거를 기대할 만한 질문일 때만 작성한다.
- 최대 2개까지만 작성한다.
- summary, action, nextQuestion에는 절대 언급하지 않는다.
- 설명 문장, 해설 문구를 쓰지 않는다.
- 형식은 다음을 따른다:

  title:
  - 사람이 이해할 수 있는 평서문
  - 핵심 사실만 담는다.

  source:
  - 학술지명 또는 가이드라인 명 + 연도만 표기한다.
  - URL, DOI, 저자명 금지.

행동 원칙:
- 정확함보다 ‘항상 쓸 수 있는 밀도’를 우선한다.
- 전문가처럼 말하지 않는다.
- 사용자의 머릿속을 대신 정리해주는 톤을 유지한다.
- 사용자가 “아, 내 얘기네”라고 느끼게 하는 것이 최우선 목표다.
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
