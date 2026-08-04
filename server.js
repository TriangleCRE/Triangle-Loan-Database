// Local dev entrypoint. On Vercel, api/index.js exports the same app as a
// serverless function instead of calling listen().
"use strict";

const app = require("./app");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Triangle Loan Database listening on http://localhost:${PORT}`);
});
