// /api/answer.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = typeof req.body === "string" ? safeJsonParse(req.body, {}) : (req.body || {});
    const mode = (body.mode || "counsel").toString(); // "counsel" | "mybody"
    const userText = (body.text || "").toString().trim();
    const turns = Array.isArray(body.turns) ? body.turns.slice(-12) : []; // [{q,aHtml}] or {q,a}
    const myBody = body.myBody || {}; // optional: user metrics snapshot

    if (!userText) return res.status(400).json({ error: "Missing text" });

    const system = [
      "너는 ANSWER 프로젝트의 상담/마이바디 통합 MVP용 응답 엔진이다.",
      "출력은 반드시 5.5줄 룰로만 작성한다. 정확히 6줄(줄바꿈 기준)로 고정한다.",
      "각 줄은 다음 접두어로 시작한다: 핵심요약:, 가능성TOP3:, 지금할1가지:, 다음질문:, 근거:, 위험신호:.",
      "절대 금지: 마크다운(**, #, -, > 등), 불릿/번호목록 서식, 이모지, 링크/URL, 각주/인용문, 장문의 설명.",
      "다음질문은 반드시 1개만, 문장 끝은 물음표로 끝낼 것. (문진은 평균 2회, 최대 3회까지만 유도)",
      "근거 줄에는 연구/가이드라인/전문가합의/일반생리/사용자입력 중 해당하는 '근거 타입'만 짧게 적는다. (세부 출처/논문명/기관명 금지)",
      "위험신호 줄에는 짧게: 즉시 진료/응급실 고려가 필요한 레드플래그만 나열. 없으면 '뚜렷한 위험신호 없음'이라고 쓴다.",
      "사용자가 민감 주제(의학/법/투자 등)를 물어도 안전문구를 반복해서 붙이지 말고, 오직 5.5줄 룰로만 답한다.",
      "모르면 모른다고 짧게 말하고, 다음질문에서 필요한 정보 1개만 요청한다.",
      "항상 사용자가 '지금 당장 할 수 있는 1가지 행동'을 구체적으로 1개만 제시한다.",
    ].join("\n");

    const context = [
      `모드: ${mode}`,
      "최근 대화(최신순, 요약 금지/그대로 참고):",
      ...turns.map((t, i) => {
        const q = (t && t.q) ? String(t.q) : "";
        const a = (t && (t.a || t.aHtml)) ? String(t.a || t.aHtml) : "";
        return `Turn${i + 1} Q: ${q}\nTurn${i + 1} A: ${a}`;
      }),
      "MyBody 스냅샷(있으면 참고, 없으면 무시):",
      JSON.stringify(myBody).slice(0, 2000),
      "사용자 최신 입력:",
      userText
    ].join("\n");

    const user = [
      "위 컨텍스트를 바탕으로 5.5줄 룰(정확히 6줄)로만 답하라.",
      "줄 수를 늘리거나 줄을 합치지 마라. 각 줄은 1문장 중심으로 짧게.",
      "가능성TOP3는 쉼표로 3개만 나열(예: A, B, C).",
      "지금할1가지에는 행동 1개만(예: 10분 걷기 / 물 300ml / 오늘 저녁 탄수 1/2로).",
      "다음질문은 정보 1개만 묻는 질문 1개.",
      "근거는 타입만.",
      "위험신호는 레드플래그만, 없으면 없음."
    ].join("\n");

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-5",
      temperature: 0.4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: context },
        { role: "user", content: user },
      ],
    });

    const text = (completion.choices?.[0]?.message?.content || "").trim();

    // 방어: 줄 수 강제(6줄)
    const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
    const fixed = [];
    const wanted = ["핵심요약:", "가능성TOP3:", "지금할1가지:", "다음질문:", "근거:", "위험신호:"];
    for (const w of wanted) {
      const found = lines.find(l => l.startsWith(w));
      fixed.push(found || `${w} 정보가 부족함`);
    }
    const finalText = fixed.join("\n");

    return res.status(200).json({ text: finalText });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
