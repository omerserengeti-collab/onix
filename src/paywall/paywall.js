document.addEventListener('DOMContentLoaded', () => {
  const btnBuy = document.getElementById('btn-buy');
  const btnActivate = document.getElementById('btn-activate');
  const licenseKeyInput = document.getElementById('license-key');
  const statusMessage = document.getElementById('status-message');
  const manageLink = document.getElementById('manage-link');

  // Buy button — open checkout URL in browser
  btnBuy.addEventListener('click', () => {
    window.onix.buyLicense();
  });

  // Activate button — validate the entered key
  btnActivate.addEventListener('click', async () => {
    const key = licenseKeyInput.value.trim();

    if (!key) {
      statusMessage.textContent = 'Please enter a license key.';
      statusMessage.className = 'status-message error';
      return;
    }

    statusMessage.textContent = 'Validating...';
    statusMessage.className = 'status-message';

    try {
      const result = await window.onix.validateLicense(key);
      if (result && result.valid) {
        statusMessage.textContent = 'License activated! Onix is now unlocked.';
        statusMessage.className = 'status-message success';
        // Window will be closed by main process
      } else {
        statusMessage.textContent = result.message || 'Invalid license key. Keys start with "ONIX-".';
        statusMessage.className = 'status-message error';
      }
    } catch (err) {
      statusMessage.textContent = 'Validation failed. Please try again.';
      statusMessage.className = 'status-message error';
    }
  });

  // Allow pressing Enter to activate
  licenseKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnActivate.click();
    }
  });

  // Manage licenses link
  manageLink.addEventListener('click', (e) => {
    e.preventDefault();
    window.onix.buyLicense();
  });
});
