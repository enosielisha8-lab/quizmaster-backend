import express from "express";

const app = express();

app.use(express.json({ limit: "10kb" }));

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.GEMINI_API_KEY;

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

        if (
            typeof topic !== "string" ||
            topic.trim().length === 0 ||
            topic.length > 100
        ) {
            return res.status(400).json({
                error: "Please provide a valid topic."
            });
        }

        const prompt = `
Create one educational multiple-choice quiz question.

Topic: ${topic}

Requirements:
- Make the question accurate and clear.
- Provide exactly four answer options.
- Only one option must be correct.
- correctAnswerIndex must be 0, 1, 2, or 3.
- Give a short explanation of the correct answer.
- Vary the questions when this endpoint is called repeatedly.
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
            console.error(
                "Gemini API error:",
                response.status
            );

            return res.status(502).json({
                error: "AI could not generate a question. Please try again."
            });
        }

        const data = await response.json();

        const text =
            data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
            return res.status(502).json({
                error: "AI returned an empty response."
            });
        }

        const questionData = JSON.parse(text);

        if (
            typeof questionData.question !== "string" ||
            !Array.isArray(questionData.options) ||
            questionData.options.length !== 4 ||
            !Number.isInteger(questionData.correctAnswerIndex) ||
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

        return res.json(questionData);

    } catch (error) {
        console.error("Question error:", error.message);

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
