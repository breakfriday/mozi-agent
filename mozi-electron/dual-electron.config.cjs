const path = require("node:path");

/**
 * The only integration point with a DualVite project. Keep this path relative
 * to the Electron project so moving both sibling projects remains easy.
 */
module.exports = {
  rendererDir: path.resolve(__dirname, "../mozi-app"),
  rendererDevUrl: "http://127.0.0.1:5173/",
  rendererHash: "/",
};
