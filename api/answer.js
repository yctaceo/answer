import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const { message } = body || {};

    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await client.responses.create({
      model: "gpt-5.2",
      max_output_tokens: 600,
      input: [
        {
          role: "system",
          content:
            "You are ANSWER, a concise, calm, and evidence-aware health assistant. Do not give medical diagnoses. Focus on explanations, lifestyle context, and when to consider professional help.",
        },
        {
          role: "user",
          content: message,
        },
      ],
    });

    return res.status(200).json({
      text: response.output_text,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      detail: err?.message || String(err),
    });
  }
}
