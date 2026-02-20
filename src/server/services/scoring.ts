export function scoreMultipleChoice(correctIndex: number, userAnswer: string): {
  correctness: "correct" | "incorrect";
  score: number;
} {
  const parsed = Number.parseInt(userAnswer, 10);
  if (Number.isNaN(parsed)) {
    return { correctness: "incorrect", score: 0 };
  }
  const isCorrect = parsed === correctIndex;
  return { correctness: isCorrect ? "correct" : "incorrect", score: isCorrect ? 1 : 0 };
}
