// /api/answer.js  (CommonJS for Vercel)
// - returns JSON object ONLY (root-level fields)
// - references format: "문장\n— 출처, 연도"

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

// 모델이 JSON 앞뒤로 말을 붙이거나, 코드블록으로 감싸도 JSON 객체만 최대한 추출
function extractFirstJsonObject(text) {
  if (!text) return null;
  const s = String(text).trim();

  // ```json ... ``` 제거
  const deFenced = s
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const direct = safeJsonParse(deFenced, null);
  if (direct && typeof direct === "object") return direct;

  const first = deFenced.indexOf("{");
  const last = deFenced.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const chunk = deFenced.slice(first, last + 1);
    const obj = safeJsonParse(chunk, null);
    if (obj && typeof obj === "object") return obj;
  }
  return null;
}

function pickStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function pickArr3(v) {
  if (Array.isArray(v)) {
    const a = v.map((x) => pickStr(x)).filter(Boolean);
    return [a[0] || "", a[1] || "", a[2] || ""];
  }
  if (typeof v === "string") {
    const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
    return [parts[0] || "", parts[1] || "", parts[2] || ""];
  }
  return ["", "", ""];
}

// references: [{title, source}] / ["..."] / "..." 모두 받아서
// 최종은 ["문장\n— 출처, 연도", ...] 최대 2개로 정규화
function normalizeReferences(refs) {
  const out = [];

  const pushOne = (title, source) => {
    const t = pickStr(title);
    const s = pickStr(source);
    if (!t || !s) return;
    out.push(`${t}\n— ${s}`);
  };

  if (!refs) return out;

  if (Array.isArray(refs)) {
    for (const r of refs) {
      if (out.length >= 2) break;

      if (typeof r === "string") {
        const line = r.trim();
        if (!line) continue;

        // 이미 "...\n— ..." 형태면 그대로
        if (line.includes("\n— ")) {
          out.push(line);
          continue;
        }

        // "fact -- source, year" 형태도 흡수
        const m = line.split("--").map((x) => x.trim());
        if (m.length >= 2) {
          pushOne(m[0], m.slice(1).join(" -- "));
        } else {
          // source 정보가 없으면 버림(형식 강제)
        }
      } else if (r && typeof r === "object") {
        pushOne(r.title, r.source);
      }
    }
  } else if (typeof refs === "object") {
    pushOne(refs.title, refs.source);
  } else if (typeof refs === "string") {
    // 단일 문자열인 경우도 최대한 파싱
    const line = refs.trim();
    if (line.includes("\n— ")) out.push(line);
    else {
      const m = line.split("--").map((x) => x.trim());
      if (m.length >= 2) pushOne(m[0], m.slice(1).join(" -- "));
    }
  }

  return out.slice(0, 2);
}

function normalizeAnswer(obj) {
  const out = {
    summary: "",
    top3: ["", "", ""],
    action: "",
    nextQuestion: "",
    evidenceType: "",
    redFlag: "뚜렷한 위험신호 없음",
    references: [],
    meta: { version: "answer-json-v1.1.1", lang: "ko", missing: [] },
  };

  if (!obj || typeof obj !== "object") {
    out.summary = "정보가 부족해서, 우선 핵심만 정리해볼게. 지금 말해준 변화는 특정 상황에서 흔히 나타나요.";
    out.top3 = ["정보부족", "정보부족", "정보부족"];
    out.action = "지금부터 24시간 동안, 증상이 가장 심해지는 ‘시간대’를 1번만 메모해줘.";
    out.nextQuestion = "처음 시작된 시점이 언제야?";
    out.evidenceType = "사용자입력";
    out.meta.missing.push("all");
    return out;
  }

  out.summary = pickStr(obj.summary);
  out.top3 = pickArr3(obj.top3);
  out.action = pickStr(obj.action);
  out.nextQuestion = pickStr(obj.nextQuestion);
  out.evidenceType = pickStr(obj.evidenceType);
  out.redFlag = pickStr(obj.redFlag) || "뚜렷한 위험신호 없음";
  out.references = normalizeReferences(obj.references);

  if (!out.summary) out.meta.missing.push("summary");
  if (!out.top3.some(Boolean)) out.meta.missing.push("top3");
  if (!out.action) out.meta.missing.push("action");
  if (!out.nextQuestion) out.meta.missing.push("nextQuestion");
  if (!out.evidenceType) out.meta.missing.push("evidenceType");

  // nextQuestion는 반드시 1개 + 물음표
  if (out.nextQuestion && !out.nextQuestion.endsWith("?")) out.nextQuestion += "?";

  // top3 빈칸 채우기
  for (let i = 0; i < 3; i++) if (!out.top3[i]) out.top3[i] = "정보부족";

  // evidenceType 허용값 강제
  const allowedEvidence = new Set(["사용자입력", "일반생리", "전문가합의", "가이드라인", "연구"]);
  if (!allowedEvidence.has(out.evidenceType)) {
    out.evidenceType = out.evidenceType ? "전문가합의" : "사용자입력";
  }

  // redFlag 기본값
  if (!out.redFlag) out.redFlag = "뚜렷한 위험신호 없음";

  // 너무 비면 안전 폴백
  if (out.meta.missing.length >= 4) {
    out.summary = out.summary || "정보가 부족해서, 우선 핵심만 정리해볼게. 이런 변화는 특정 생활요인과 함께 나타날 때가 있어.";
    out.action = out.action || "오늘은 증상이 심해지는 상황을 1번만 기록해줘.";
    out.nextQuestion = out.nextQuestion || "이게 처음 시작된 시점이 언제야?";
    out.evidenceType = out.evidenceType || "사용자입력";
    out.redFlag = out.redFlag || "뚜렷한 위험신호 없음";
  }

  return out;
}

function buildSystemPrompt() {
  return `
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
- 불충분하게 약하게 쓰지 말고, “지금 당장 할 수 있는 수준에서 가장 효과 큰 1개”로 쓴다.
  (예: 보습은 “샤워 후 3분 안에 전신 1회 + 밤에 1회”처럼 구체/적극적으로)

4. nextQuestion
- 질문은 반드시 1개만 작성한다.
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
- 최대 2개까지만 작성한다.
- summary, action, nextQuestion에는 절대 언급하지 않는다.
- 설명 문장, 해설 문구를 쓰지 않는다.
- 형식:
  title: 사람이 이해할 수 있는 평서문(핵심 사실 1줄)
  source: 학술지명 또는 가이드라인 명 + 연도만 (URL/DOI/저자명 금지)
`.trim();
}

function buildUserContext({ mode, turns, myBody, userText }) {
  return [
    `mode=${String(mode || "counsel")}`,
    "turns=" + JSON.stringify(Array.isArray(turns) ? turns.slice(-12) : []).slice(0, 2000),
    "myBody=" + JSON.stringify(myBody || {}).slice(0, 2000),
    "user=" + String(userText || ""),
  ].join("\n");
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = typeof req.body === "string" ? safeJsonParse(req.body, {}) : (req.body || {});

    // 프론트/이전버전 payload 모두 수용
    const mode = (body.mode || "counsel").toString();
    const userText = String(body.text || body.message || body.input || "").trim();

    // turns / history 모두 수용
    const turns =
      Array.isArray(body.turns) ? body.turns :
      Array.isArray(body.history) ? body.history :
      [];

    const myBody = body.myBody || body.body || {};

    if (!userText) {
      return res.status(400).json({ error: "Missing text" });
    }

    const system = buildSystemPrompt();
    const context = buildUserContext({ mode, turns, myBody, userText });

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: context },
      ],
    });

    const raw = String(completion?.choices?.[0]?.message?.content || "").trim();
    const obj = extractFirstJsonObject(raw);
    const answer = normalizeAnswer(obj);

    // references 최종 포맷 강제: "...\n— ..."
    answer.references = normalizeReferences(
      // 모델이 references를 제대로 줬으면 그대로, 아니면 빈 배열
      obj && typeof obj === "object" ? obj.references : []
    );

    // ⭐ 프론트가 json.summary를 기대하므로 "answer"로 감싸지 않고 루트로 반환
    return res.status(200).json(answer);
  } catch (err) {
    console.error(err);
    // 프론트가 summary 유무로 정상응답 판단하므로, 에러도 스키마 유지
    return res.status(500).json({
      summary: "서버 연결에 문제가 있었을 수 있어요. 지금은 요청이 정상 처리되지 않았어요.",
      top3: ["연결 오류", "환경 설정", "일시적 장애"],
      action: "30초 뒤에 같은 문장을 1번만 다시 보내줘.",
      nextQuestion: "지금도 같은 문제가 계속 나와?",
      evidenceType: "사용자입력",
      redFlag: "뚜렷한 위험신호 없음",
      references: [],
      meta: { version: "answer-json-v1.1.1", lang: "ko", missing: ["server_error"] },
    });
  }
};
