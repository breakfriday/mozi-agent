const path = require("node:path");

/**
 * The only integration point with a DualVite project. Keep this path relative
 * to the Electron project so moving both sibling projects remains easy.
 */
module.exports = {
  rendererDir: path.resolve(__dirname, "../mozi-app"),
  // Match mozi-app/.env.web VITE_APP_BASE; IPC validates the loaded document path.
  rendererDevUrl: "http://127.0.0.1:5173/mozi_app/",
  rendererHash: "/",
};
