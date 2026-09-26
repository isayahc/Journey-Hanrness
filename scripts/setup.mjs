import { copyFile, constants } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function setup(root = new URL("../", import.meta.url)) {
  try {
    await copyFile(new URL(".env.example", root), new URL(".env", root), constants.COPYFILE_EXCL);
    console.log("Created .env. Set MONGODB_URI to your Atlas connection string, then run npm start.");
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log("Existing .env preserved. Run npm start when your database is ready.");
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  setup().catch(() => { console.error("Setup failed. Check that the project directory is writable."); process.exitCode = 1; });
}
