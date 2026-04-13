const { net } = require('electron');

function track(eventName, data = {}) {
  try {
    const request = net.request({
      method: 'POST',
      url: 'https://cloud.umami.is/api/send',
    });

    request.setHeader('Content-Type', 'application/json');
    request.setHeader('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    const payload = JSON.stringify({
      type: 'event',
      payload: {
        website: 'a88562e2-19db-41b6-b4a4-c3bedc902aa8',
        name: eventName,
        url: '/',
        hostname: 'app.onix',
        language: 'en-US',
        screen: '1920x1080',
      }
    });

    request.write(payload);
    request.end();

    request.on('response', (response) => {
      console.log('[Umami] status:', response.statusCode);
    });

    request.on('error', (err) => {
      console.error('[Umami] error:', err);
    });

  } catch (e) {
    console.error('[Umami] track error:', e);
  }
}

module.exports = { track };
