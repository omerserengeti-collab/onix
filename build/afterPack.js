// After electron-builder packs the .app, re-sign everything
// with a consistent ad-hoc signature so Team IDs match.
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (process.platform !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[afterPack] Re-signing ${appPath} with consistent ad-hoc identity...`);

  try {
    // Remove any existing signatures and quarantine flags
    execSync(`xattr -cr "${appPath}"`, { stdio: 'inherit' });

    // Sign all frameworks and helpers first (deep inside out)
    execSync(
      `codesign --force --deep --sign - --entitlements "${path.join(__dirname, 'entitlements.mac.plist')}" "${appPath}"`,
      { stdio: 'inherit' }
    );

    console.log('[afterPack] Re-signing complete.');
  } catch (err) {
    console.error('[afterPack] Re-signing failed:', err.message);
  }
};
