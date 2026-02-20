import dotenv from "dotenv";
import { createApp } from "./app.js";

dotenv.config();

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`Self-learning quiz maker running at http://${host}:${port}`);
});
