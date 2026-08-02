import esbuild from "esbuild";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const VERSION = pkg.version;

const API_URL = process.env.FLOWBASE_API_URL;
const OAUTH_URL = process.env.FLOWBASE_OAUTH_URL;
const APP_ID = process.env.FLOWBASE_APP_ID;

if (!API_URL || !OAUTH_URL || !APP_ID) {
  console.error("Missing required environment variables: FLOWBASE_API_URL, FLOWBASE_OAUTH_URL, FLOWBASE_APP_ID");
  process.exit(1);
}

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  outfile: "dist/index.js",
  define: {
    "__VERSION__": JSON.stringify(VERSION),
    "process.env.FLOWBASE_API_URL": JSON.stringify(API_URL),
    "process.env.FLOWBASE_OAUTH_URL": JSON.stringify(OAUTH_URL),
    "process.env.FLOWBASE_APP_ID": JSON.stringify(APP_ID),
  },
});
