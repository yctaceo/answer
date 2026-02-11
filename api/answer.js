const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, history = [] } = req.body;

  const systemRole = `
    당신은 사용자의 몸 상태와 신호를 듣고 이를 차분하게 정리해주는 파트너 'ANSWER'입니다.
    전문가나 의사처럼 군림하지 말고, 친구처럼 사용자의 신호를 기록하고 연결해주는 역할을 수행하세요.

    [규칙]
    1. 캐릭터: "내 몸을 정리해주는 파트너". 기능의학/전문가 언급 금지.
    2. 말투: "입력해주신 내용은 ~와 연결될 수 있어요", "~일 때 자주 관찰되는 신호예요" 등 완충형 표현만 사용. (입니다/확실합니다 절대 금지)
    3. Action: 바로 실행 가능한 구체적 행동 1개 (숫자 포함).
    4. Next Question: 1개만, 질문 형식.
    5. References (최대 2개): 반드시 다음 2줄 형식을 문자열로 반환. 
       - 1줄: 사실 평서문
       - 2줄: — 출처명, 연도
       - 예: "카페인은 부신 호르몬 분비를 일시적으로 촉진할 수 있습니다.\n— 내분비학회지, 2021"
    6. evidenceType: 사용자입력 / 일반생리 / 전문가합의 / 가이드라인 / 연구 중 하나만 선택.
    7. redFlag: 위험 요소가 없으면 "뚜렷한 위험신호 없음" 문자열 고정.

    [Output JSON Schema]
    {
      "summary": "완충형 정리 문장",
      "top3": ["태그1", "태그2", "태그3"],
      "action": "숫자 포함 행동 1개",
      "nextQuestion": "다음 질문?",
      "evidenceType": "값 고정",
      "redFlag": "위험신호 혹은 고정문구",
      "references": ["2줄문자열1", "2줄문자열2"]
    }
  `;

  const fallback = {
    summary: "말씀해주신 신호들을 잘 기록해두었어요. 지금은 평소와 비슷한 흐름일 수 있어요.",
    top3: ["상태기록", "신호관찰", "일상"],
    action: "물 1컵을 천천히 마시며 5분간 휴식해 보세요.",
    nextQuestion: "이 현상이 하루 중 언제 주로 나타나나요?",
    evidenceType: "사용자입력",
    redFlag: "뚜렷한 위험신호 없음",
    references: []
  };

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemRole }, ...history, { role: "user", content: message }],
      response_format: { type: "json_object" }
    });

    let result = JSON.parse(response.choices[0].message.content);
    
    // 자연스러운 완충형 보정
    if (result.summary) {
        result.summary = result.summary
          .replace(/입니다/g, "일 수 있어요")
          .replace(/확실합니다/g, "연결되는 것 같아요")
          .replace(/판단됩니다/g, "보여요");
    }
    
    if (!result.redFlag) result.redFlag = "뚜렷한 위험신호 없음";
    if (!result.references) result.references = [];

    return res.status(200).json(result);
  } catch (error) {
    return res.status(200).json(fallback);
  }
}
