const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function(context) {
  if (process.platform !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  console.log(`Deep ad-hoc re-sign: ${appPath}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
};
