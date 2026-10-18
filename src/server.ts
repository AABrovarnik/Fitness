import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();
app.listen(config.port, () => {
  console.log(`FitClub Personal running on http://localhost:${config.port}`);
});
