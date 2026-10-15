import express from "express";
import { randomUUID } from "crypto";

const app = express();

app.use(express.json({ limit: "30kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

// Kumbukumbu ya maswali kwa kila quiz session.
// Huhifadhiwa kwenye RAM ya server; inaweza kupotea
// server ikirestart au ikilala.
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
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
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
                "Gemini API error:",
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

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `Quiz Master backend running on port ${PORT}`
    );
});
