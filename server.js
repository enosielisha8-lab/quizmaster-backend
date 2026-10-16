import express from "express";

const app = express();

app.use(express.json({ limit: "30kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_URL =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

// ==================================================
// QUIZ SESSION MEMORY
// ==================================================

const quizSessions = new Map();

const MAX_QUESTIONS_PER_SESSION = 1000;
const MAX_SESSION_AGE = 6 * 60 * 60 * 1000;

function cleanOldSessions() {
    const now = Date.now();

    for (const [sessionId, session] of quizSessions) {
        if (now - session.updatedAt > MAX_SESSION_AGE) {
            quizSessions.delete(sessionId);
        }
    }
}

function normalizeQuestion(question) {
    return question
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// ==================================================
// CLEAN AI TUTOR ANSWERS
// ==================================================

function cleanTutorAnswer(answer) {
    if (typeof answer !== "string") {
        return "";
    }

    let text = answer;

    // Remove Markdown heading symbols.
    text = text.replace(/^\s{0,3}#{1,6}\s*/gm, "");

    // Convert Markdown bullet lists into clean bullet points.
    text = text.replace(/^\s*[-*+]\s+/gm, "• ");

    // Remove bold and italic formatting symbols.
    text = text.replace(/\*{1,2}([^*\n]+)\*{1,2}/g, "$1");
    text = text.replace(/_{1,2}([^_\n]+)_{1,2}/g, "$1");

    // Remove inline code formatting.
    text = text.replace(/`([^`\n]+)`/g, "$1");

    // Remove code-block fences while preserving their content.
    text = text.replace(/```[a-zA-Z0-9_-]*\s*\n?/g, "");
    text = text.replace(/```/g, "");

    // Remove horizontal Markdown separators.
    text = text.replace(/^\s*[-*_]{3,}\s*$/gm, "");

    // Clean excessive blank lines.
    text = text.replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n");

    return text.trim();
}

// ==================================================
// HOME AND HEALTH
// ==================================================

app.get("/", (req, res) => {
    res.json({
        message: "Quiz Master AI Backend is running!"
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "OK"
    });
});

// ==================================================
// QUIZ MASTER: GENERATE QUESTIONS
// ==================================================

app.post("/api/question", async (req, res) => {
    try {
        if (!API_KEY) {
            return res.status(500).json({
                error: "AI API key is not configured."
            });
        }

        const topic = req.body.topic;
        const difficulty = req.body.difficulty || "Easy";
        const sessionId = req.body.sessionId;

        if (
            typeof topic !== "string" ||
            topic.trim().length === 0 ||
            topic.trim().length > 100
        ) {
            return res.status(400).json({
                error: "Please provide a valid topic."
            });
        }

        if (
            typeof sessionId !== "string" ||
            sessionId.length < 1 ||
            sessionId.length > 100
        ) {
            return res.status(400).json({
                error: "A valid quiz sessionId is required."
            });
        }

        const allowedDifficulties = [
            "Easy",
            "Medium",
            "Hard"
        ];

        if (!allowedDifficulties.includes(difficulty)) {
            return res.status(400).json({
                error: "Difficulty must be Easy, Medium, or Hard."
            });
        }

        cleanOldSessions();

        const sessionKey =
            sessionId + "::" +
            topic.trim().toLowerCase() + "::" +
            difficulty;

        let session = quizSessions.get(sessionKey);

        if (!session) {
            session = {
                questions: [],
                normalizedQuestions: new Set(),
                updatedAt: Date.now()
            };

            quizSessions.set(sessionKey, session);
        }

        if (
            session.questions.length >=
            MAX_QUESTIONS_PER_SESSION
        ) {
            return res.status(429).json({
                error: "This quiz session has reached its question limit. Start a new quiz."
            });
        }

        let difficultyInstructions = "";

        if (difficulty === "Easy") {
            difficultyInstructions = `
- Test basic knowledge and simple concepts.
- Use clear language suitable for beginners.
- Focus on understanding fundamental ideas.
`;
        } else if (difficulty === "Medium") {
            difficultyInstructions = `
- Test understanding and application.
- Require reasoning, not only memorization.
- Use moderately challenging options.
`;
        } else {
            difficultyInstructions = `
- Test advanced understanding and problem-solving.
- Require deeper reasoning and analysis.
- Use plausible distractors.
- Ensure only one answer is correct.
`;
        }

        const recentQuestions =
            session.questions.slice(-40);

        const prompt = `
Create ONE new educational multiple-choice question.

TOPIC: ${topic.trim()}
DIFFICULTY: ${difficulty}

DIFFICULTY REQUIREMENTS:
${difficultyInstructions}

QUESTION VARIETY REQUIREMENTS:
Choose a different question approach from these possibilities:
- Concept or definition
- Practical application
- Real-world scenario
- Problem-solving
- Cause and effect
- Compare and contrast
- Troubleshooting
- Interpretation or analysis
- Best practice
- Identify an error
- Predict an outcome

Choose an approach suitable for the topic.
Do not force a question type that does not fit the topic.

QUESTIONS ALREADY ASKED IN THIS QUIZ:
${recentQuestions.length > 0
    ? recentQuestions.map((q, i) =>
        `${i + 1}. ${q}`
      ).join("\n")
    : "No previous questions."}

STRICT RULES:
- Do not repeat any previous question.
- Do not merely rewrite a previous question using synonyms.
- Test a different concept, scenario, example, or skill.
- Avoid using the same correct answer pattern repeatedly.
- Keep the question relevant to the specified topic.
- Provide exactly four answer options.
- Only one option must be correct.
- correctAnswerIndex must be 0, 1, 2, or 3.
- Provide a short explanation.
- Return only valid JSON matching the requested schema.
`;

        const response = await fetch(
            GEMINI_URL,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": API_KEY
                },
                body: JSON.stringify({
                    contents: [
                        {
                            parts: [
                                {
                                    text: prompt
                                }
                            ]
                        }
                    ],
                    generationConfig: {
                        temperature: 1,
                        responseMimeType: "application/json",
                        responseSchema: {
                            type: "OBJECT",
                            properties: {
                                question: {
                                    type: "STRING"
                                },
                                options: {
                                    type: "ARRAY",
                                    items: {
                                        type: "STRING"
                                    }
                                },
                                correctAnswerIndex: {
                                    type: "INTEGER"
                                },
                                explanation: {
                                    type: "STRING"
                                }
                            },
                            required: [
                                "question",
                                "options",
                                "correctAnswerIndex",
                                "explanation"
                            ]
                        }
                    }
                })
            }
        );

        if (!response.ok) {
            const errorText = await response.text();

            console.error(
                "Gemini Quiz API error:",
                response.status,
                errorText
            );

            return res.status(502).json({
                error: "AI could not generate a question. Please try again."
            });
        }

        const data = await response.json();

        const generatedText =
            data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!generatedText) {
            return res.status(502).json({
                error: "AI returned an empty response."
            });
        }

        const questionData = JSON.parse(generatedText);

        if (
            typeof questionData.question !== "string" ||
            !Array.isArray(questionData.options) ||
            questionData.options.length !== 4 ||
            !Number.isInteger(
                questionData.correctAnswerIndex
            ) ||
            questionData.correctAnswerIndex < 0 ||
            questionData.correctAnswerIndex > 3 ||
            typeof questionData.explanation !== "string" ||
            !questionData.options.every(
                option => typeof option === "string"
            )
        ) {
            return res.status(502).json({
                error: "AI returned an invalid question."
            });
        }

        const normalized =
            normalizeQuestion(questionData.question);

        if (session.normalizedQuestions.has(normalized)) {
            return res.status(502).json({
                error: "AI repeated a previous question. Please request another question."
            });
        }

        session.questions.push(questionData.question);
        session.normalizedQuestions.add(normalized);
        session.updatedAt = Date.now();

        return res.json(questionData);

    } catch (error) {
        console.error(
            "Question error:",
            error.message
        );

        return res.status(500).json({
            error: "Something went wrong. Please try again."
        });
    }
});

// ==================================================
// AI TUTOR: TEACH AND ANSWER QUESTIONS
// ==================================================

app.post("/api/tutor", async (req, res) => {
    try {
        if (!API_KEY) {
            return res.status(500).json({
                error: "AI API key is not configured."
            });
        }

        const message = req.body.message;
        const history = req.body.history;

        if (
            typeof message !== "string" ||
            message.trim().length === 0 ||
            message.trim().length > 4000
        ) {
            return res.status(400).json({
                error: "Please provide a question or topic of up to 4000 characters."
            });
        }

        if (
            history !== undefined &&
            !Array.isArray(history)
        ) {
            return res.status(400).json({
                error: "Conversation history must be a list."
            });
        }

        const suppliedHistory =
            Array.isArray(history) ? history : [];

        const recentHistory =
            suppliedHistory.slice(-12);

        const validHistory = [];

        for (const item of recentHistory) {
            if (
                !item ||
                typeof item.role !== "string" ||
                typeof item.text !== "string"
            ) {
                return res.status(400).json({
                    error: "Invalid conversation history."
                });
            }

            if (
                item.role !== "user" &&
                item.role !== "model"
            ) {
                return res.status(400).json({
                    error: "Conversation role must be user or model."
                });
            }

            if (
                item.text.trim().length === 0 ||
                item.text.length > 4000
            ) {
                return res.status(400).json({
                    error: "A conversation message is empty or too long."
                });
            }

            validHistory.push({
                role: item.role,
                parts: [
                    {
                        text: item.text
                    }
                ]
            });
        }

        const systemInstruction = {
            parts: [
                {
                    text: `
You are AI Tutor, an educational teacher inside the Quiz Master app.

Your purpose is to teach topics and answer questions clearly.

IMPORTANT RESPONSE FORMATTING RULES:

1. Use plain text only.
2. Do not use Markdown formatting.
3. Never use asterisks for bold or italic text.
4. Never use hash symbols for headings.
5. Do not wrap words in backticks.
6. Do not create Markdown tables.
7. Use simple headings on their own lines without special symbols.
8. Use numbered lists such as 1. and 2. when steps are needed.
9. Use ordinary sentences and short paragraphs.
10. Leave a blank line between separate paragraphs.
11. Keep the answer easy to read on a mobile phone.
12. Do not use decorative separators made of repeated symbols.

TEACHING RULES:

1. Explain concepts clearly and accurately.
2. Start with simple explanations before introducing difficult ideas.
3. Give useful examples when appropriate.
4. Explain processes step by step when the user asks how something works.
5. Use language suitable for the learner.
6. Answer follow-up questions using the conversation history.
7. If the user asks for a definition, define the term and explain it.
8. If the user asks for comparisons, explain the important differences.
9. If the question is unclear, ask for clarification politely.
10. Avoid unnecessary repetition.
11. Be patient, respectful and encouraging.
12. Respond in the same language as the user whenever practical.
13. Do not invent facts or pretend to know something you do not know.
14. Focus on helping the learner understand the subject.
`
                }
            ]
        };

        const contents = validHistory.concat([
            {
                role: "user",
                parts: [
                    {
                        text: message.trim()
                    }
                ]
            }
        ]);

        const response = await fetch(
            GEMINI_URL,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": API_KEY
                },
                body: JSON.stringify({
                    systemInstruction: systemInstruction,
                    contents: contents,
                    generationConfig: {
                        temperature: 0.7,
                        maxOutputTokens: 2048
                    }
                })
            }
        );

        if (!response.ok) {
            const errorText = await response.text();

            console.error(
                "Gemini AI Tutor API error:",
                response.status,
                errorText
            );

            return res.status(502).json({
                error: "AI Tutor could not answer right now. Please try again."
            });
        }

        const data = await response.json();

        const candidate =
            data.candidates &&
            data.candidates.length > 0
                ? data.candidates[0]
                : null;

        const parts =
            candidate &&
            candidate.content &&
            Array.isArray(candidate.content.parts)
                ? candidate.content.parts
                : [];

        const rawAnswer = parts
            .map(part =>
                typeof part.text === "string"
                    ? part.text
                    : ""
            )
            .join("")
            .trim();

        if (!rawAnswer) {
            console.error(
                "AI Tutor returned no answer text."
            );

            return res.status(502).json({
                error: "AI Tutor returned an empty answer. Please try again."
            });
        }

        // Remove remaining Markdown formatting before returning.
        const answer = cleanTutorAnswer(rawAnswer);

        return res.json({
            answer: answer
        });

    } catch (error) {
        console.error(
            "AI Tutor error:",
            error.message
        );

        return res.status(500).json({
            error: "Something went wrong in AI Tutor. Please try again."
        });
    }
});

// ==================================================
// START SERVER
// ==================================================

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `Quiz Master backend running on port ${PORT}`
    );
});
