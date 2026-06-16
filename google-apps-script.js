// ==================== CONFIGURATION ====================
const CONFIG = {
  TELEGRAM_BOT_TOKEN: 'YOUR_BOT_TOKEN_HERE',
  TELEGRAM_CHAT_ID: 'YOUR_CHAT_ID_HERE',
  PAIRS: ['BTC-USDT', 'ETH-USDT', 'XRP-USDT', 'LINK-USDT'],
  EMA_PERIOD: 50,
  SL_PERCENT: 0.01,
  TP_PERCENT: 0.03,
  MIN_GAP_CANDLES: 8
};

// ==================== MAIN FUNCTION (Set Trigger on this) ====================
function runScanner() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dashSheet = ss.getSheetByName('Dashboard') || createDashboardSheet(ss);
  const signalSheet = ss.getSheetByName('Signals') || createSignalSheet(ss);

  // Update dashboard with live data every run
  updateDashboard(dashSheet);

  // Check for new signals and send Telegram
  for (const symbol of CONFIG.PAIRS) {
    try {
      const data1h = fetchKlines(symbol, '1hour', 100);
      const data15m = fetchKlines(symbol, '15min', 200);

      if (!data1h.length || !data15m.length) continue;

      const signal = generateSignal(data1h, data15m);

      if (signal) {
        const lastSignalKey = symbol + '_last';
        const props = PropertiesService.getScriptProperties();
        const lastSent = props.getProperty(lastSignalKey);
        const signalId = signal.type + '_' + signal.time;

        if (lastSent !== signalId) {
          const currentPrice = data15m[data15m.length - 1].close;
          const entry = signal.price;
          const sl = signal.type === 'BUY' ? entry * (1 - CONFIG.SL_PERCENT) : entry * (1 + CONFIG.SL_PERCENT);
          const tp = signal.type === 'BUY' ? entry * (1 + CONFIG.TP_PERCENT) : entry * (1 - CONFIG.TP_PERCENT);

          sendTelegramSignal(symbol, signal, entry, sl, tp, currentPrice);
          logSignalToSheet(signalSheet, symbol, signal, entry, sl, tp, currentPrice);
          props.setProperty(lastSignalKey, signalId);
        }
      }
    } catch (e) {
      Logger.log('Error for ' + symbol + ': ' + e.message);
    }
  }

  // Update signal statuses (check if TP/SL hit)
  updateSignalStatuses(signalSheet);
}

// ==================== DASHBOARD (Always shows live data) ====================
function updateDashboard(sheet) {
  var rows = [['Pair', 'Price', '1H Trend', '1H EMA 50', 'Price vs EMA', 'Last Signal', 'Entry', 'TP (+3%)', 'SL (-1%)', 'Signal Status', 'Last Updated']];

  for (var p = 0; p < CONFIG.PAIRS.length; p++) {
    var symbol = CONFIG.PAIRS[p];
    try {
      var data1h = fetchKlines(symbol, '1hour', 100);
      var data15m = fetchKlines(symbol, '15min', 200);

      if (!data1h.length || !data15m.length) {
        rows.push([symbol, 'NO DATA', '-', '-', '-', '-', '-', '-', '-', '-', new Date()]);
        continue;
      }

      var ema50_1h = calculateEMA(data1h, CONFIG.EMA_PERIOD);
      var lastIdx1h = data1h.length - 1;
      var lastIdx15m = data15m.length - 1;
      var currentPrice = data15m[lastIdx15m].close;
      var emaValue = ema50_1h[lastIdx1h] || 0;
      var trend = data1h[lastIdx1h].close > emaValue ? 'BULLISH' : 'BEARISH';
      var priceVsEma = currentPrice > emaValue ? 'ABOVE' : 'BELOW';

      // Get all signals to find the last one
      var signalInfo = getLastSignalInfo(data1h, data15m);
      var lastSignalType = signalInfo ? signalInfo.type : 'NONE';
      var entry = signalInfo ? signalInfo.price : '-';
      var tp = '-';
      var sl = '-';
      var status = 'WAITING';

      if (signalInfo) {
        var entryPrice = signalInfo.price;
        sl = signalInfo.type === 'BUY' ? entryPrice * (1 - CONFIG.SL_PERCENT) : entryPrice * (1 + CONFIG.SL_PERCENT);
        tp = signalInfo.type === 'BUY' ? entryPrice * (1 + CONFIG.TP_PERCENT) : entryPrice * (1 - CONFIG.TP_PERCENT);

        // Check current status
        if (signalInfo.type === 'BUY') {
          if (currentPrice >= tp) status = 'TP HIT';
          else if (currentPrice <= sl) status = 'SL HIT';
          else status = 'ACTIVE';
        } else {
          if (currentPrice <= tp) status = 'TP HIT';
          else if (currentPrice >= sl) status = 'SL HIT';
          else status = 'ACTIVE';
        }
      }

      rows.push([
        symbol,
        currentPrice,
        trend,
        emaValue,
        priceVsEma,
        lastSignalType,
        entry,
        tp,
        sl,
        status,
        new Date()
      ]);
    } catch (e) {
      rows.push([symbol, 'ERROR', '-', '-', '-', '-', '-', '-', '-', e.message, new Date()]);
    }
  }

  // Write all at once
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);

  // Format header
  var headerRange = sheet.getRange('1:1');
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#1a2332');
  headerRange.setFontColor('#00d4aa');
}

function getLastSignalInfo(data1h, data15m) {
  var ema50_1h = calculateEMA(data1h, CONFIG.EMA_PERIOD);

  var hourlyData = {};
  for (var h = CONFIG.EMA_PERIOD; h < data1h.length; h++) {
    if (!ema50_1h[h]) continue;
    hourlyData[data1h[h].time] = {
      ema: ema50_1h[h],
      above: data1h[h].close > ema50_1h[h]
    };
  }

  var currentHourData = null;
  var lastSignalType = null;
  var lastSignalTime = 0;
  var latestSignal = null;

  for (var i = 1; i < data15m.length; i++) {
    var candleHour = Math.floor(data15m[i].time / 3600000) * 3600000;
    if (hourlyData[candleHour]) {
      currentHourData = hourlyData[candleHour];
    }
    if (!currentHourData) continue;

    var currClose = data15m[i].close;
    var ema1h = currentHourData.ema;
    var hourAbove = currentHourData.above;

    if (hourAbove && currClose > ema1h && lastSignalType !== 'BUY' && (i - lastSignalTime) >= CONFIG.MIN_GAP_CANDLES) {
      latestSignal = { type: 'BUY', price: currClose, time: data15m[i].time, index: i };
      lastSignalType = 'BUY';
      lastSignalTime = i;
    }
    if (!hourAbove && currClose < ema1h && lastSignalType !== 'SELL' && (i - lastSignalTime) >= CONFIG.MIN_GAP_CANDLES) {
      latestSignal = { type: 'SELL', price: currClose, time: data15m[i].time, index: i };
      lastSignalType = 'SELL';
      lastSignalTime = i;
    }
  }

  return latestSignal;
}

// ==================== UPDATE SIGNAL STATUSES ====================
function updateSignalStatuses(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();

  for (var i = 0; i < data.length; i++) {
    var status = data[i][7]; // Column H = Status
    if (status !== 'ACTIVE') continue;

    var symbol = data[i][1];  // Column B
    var type = data[i][2];    // Column C
    var entry = data[i][3];   // Column D
    var tp = data[i][4];      // Column E
    var sl = data[i][5];      // Column F

    try {
      var data15m = fetchKlines(symbol, '15min', 10);
      if (!data15m.length) continue;
      var currentPrice = data15m[data15m.length - 1].close;

      var newStatus = 'ACTIVE';
      if (type === 'BUY') {
        if (currentPrice >= tp) newStatus = 'TP HIT +3%';
        else if (currentPrice <= sl) newStatus = 'SL HIT -1%';
      } else {
        if (currentPrice <= tp) newStatus = 'TP HIT +3%';
        else if (currentPrice >= sl) newStatus = 'SL HIT -1%';
      }

      if (newStatus !== 'ACTIVE') {
        sheet.getRange(i + 2, 8).setValue(newStatus);
        sheet.getRange(i + 2, 7).setValue(currentPrice); // Update current price
      } else {
        sheet.getRange(i + 2, 7).setValue(currentPrice);
      }
    } catch (e) {}
  }
}

// ==================== KUCOIN DATA FETCH ====================
function fetchKlines(symbol, interval, limit) {
  const intervalSeconds = interval === '1hour' ? 3600 : interval === '15min' ? 900 : 3600;
  const endAt = Math.floor(Date.now() / 1000);
  const startAt = endAt - (limit * intervalSeconds);

  const url = 'https://api.kucoin.com/api/v1/market/candles?type=' + interval + '&symbol=' + symbol + '&startAt=' + startAt + '&endAt=' + endAt;

  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const json = JSON.parse(response.getContentText());
  const data = json.data || [];

  // KuCoin format: [time, open, close, high, low, volume, turnover] - newest first
  return data.reverse().map(function(k) {
    return {
      time: parseInt(k[0]) * 1000,
      open: parseFloat(k[1]),
      high: parseFloat(k[3]),
      low: parseFloat(k[4]),
      close: parseFloat(k[2]),
      volume: parseFloat(k[5])
    };
  });
}

// ==================== EMA CALCULATION ====================
function calculateEMA(data, period) {
  const ema = [];
  const multiplier = 2 / (period + 1);
  var sum = 0;

  for (var i = 0; i < period; i++) {
    sum += data[i].close;
  }
  ema[period - 1] = sum / period;

  for (var i = period; i < data.length; i++) {
    ema[i] = (data[i].close - ema[i - 1]) * multiplier + ema[i - 1];
  }
  return ema;
}

// ==================== SIGNAL GENERATION (Same Rules) ====================
function generateSignal(data1h, data15m) {
  const ema50_1h = calculateEMA(data1h, CONFIG.EMA_PERIOD);

  var hourlyData = {};
  for (var h = CONFIG.EMA_PERIOD; h < data1h.length; h++) {
    if (!ema50_1h[h]) continue;
    hourlyData[data1h[h].time] = {
      ema: ema50_1h[h],
      above: data1h[h].close > ema50_1h[h]
    };
  }

  var currentHourData = null;
  var lastSignalType = null;
  var lastSignalTime = 0;
  var latestSignal = null;

  for (var i = 1; i < data15m.length; i++) {
    var candleHour = Math.floor(data15m[i].time / 3600000) * 3600000;
    if (hourlyData[candleHour]) {
      currentHourData = hourlyData[candleHour];
    }
    if (!currentHourData) continue;

    var currClose = data15m[i].close;
    var ema1h = currentHourData.ema;
    var hourAbove = currentHourData.above;

    // BUY: 1H closed above EMA 50 AND 15m candle closes above 1H EMA
    if (hourAbove && currClose > ema1h && lastSignalType !== 'BUY' && (i - lastSignalTime) >= CONFIG.MIN_GAP_CANDLES) {
      latestSignal = { index: i, type: 'BUY', price: currClose, time: data15m[i].time };
      lastSignalType = 'BUY';
      lastSignalTime = i;
    }
    // SELL: 1H closed below EMA 50 AND 15m candle closes below 1H EMA
    if (!hourAbove && currClose < ema1h && lastSignalType !== 'SELL' && (i - lastSignalTime) >= CONFIG.MIN_GAP_CANDLES) {
      latestSignal = { index: i, type: 'SELL', price: currClose, time: data15m[i].time };
      lastSignalType = 'SELL';
      lastSignalTime = i;
    }
  }

  // Only return if signal is from the last 2 candles (recent/fresh)
  if (latestSignal && latestSignal.index >= data15m.length - 2) {
    return latestSignal;
  }
  return null;
}

// ==================== TELEGRAM ALERT ====================
function sendTelegramSignal(symbol, signal, entry, sl, tp, currentPrice) {
  var emoji = signal.type === 'BUY' ? '🟢' : '🔴';
  var direction = signal.type === 'BUY' ? '📈 LONG' : '📉 SHORT';
  var pair = symbol.replace('-', '/');

  var message = emoji + ' *' + signal.type + ' SIGNAL*\n\n'
    + '🪙 *Pair:* `' + pair + '`\n'
    + '📊 *Direction:* ' + direction + '\n'
    + '⏱ *Timeframe:* 15m (1H EMA 50 Strategy)\n\n'
    + '━━━━━━━━━━━━━━━\n'
    + '💰 *Entry:* `$' + formatPrice(entry) + '`\n'
    + '🎯 *Take Profit (+3%):* `$' + formatPrice(tp) + '`\n'
    + '🛑 *Stop Loss (-1%):* `$' + formatPrice(sl) + '`\n'
    + '📍 *Current Price:* `$' + formatPrice(currentPrice) + '`\n'
    + '━━━━━━━━━━━━━━━\n\n'
    + '⚖️ *Risk:Reward* = 1:3\n'
    + '🕐 *Time:* ' + new Date(signal.time).toUTCString() + '\n\n'
    + '⚡ _CryptoScanner Pro - Auto Signal_';

  var url = 'https://api.telegram.org/bot' + CONFIG.TELEGRAM_BOT_TOKEN + '/sendMessage';

  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    }),
    muteHttpExceptions: true
  });
}

// ==================== HELPER FUNCTIONS ====================
function formatPrice(price) {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function createDashboardSheet(ss) {
  var sheet = ss.insertSheet('Dashboard');
  sheet.getRange('1:1').setFontWeight('bold');
  return sheet;
}

function createSignalSheet(ss) {
  var sheet = ss.insertSheet('Signals');
  sheet.appendRow(['Timestamp', 'Pair', 'Signal', 'Entry', 'TP (+3%)', 'SL (-1%)', 'Current Price', 'Status']);
  sheet.getRange('1:1').setFontWeight('bold');
  sheet.setColumnWidths(1, 8, 130);
  return sheet;
}

function logSignalToSheet(sheet, symbol, signal, entry, sl, tp, currentPrice) {
  sheet.appendRow([
    new Date(signal.time),
    symbol,
    signal.type,
    entry,
    tp,
    sl,
    currentPrice,
    'ACTIVE'
  ]);
}

// ==================== SETUP TRIGGER (Run once manually) ====================
function setupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runScanner') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // Run every 15 minutes
  ScriptApp.newTrigger('runScanner')
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log('Trigger set! Scanner will run every 15 minutes.');
}

// ==================== TEST FUNCTION ====================
function testTelegram() {
  var url = 'https://api.telegram.org/bot' + CONFIG.TELEGRAM_BOT_TOKEN + '/sendMessage';
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: '✅ *CryptoScanner Pro Connected!*\n\nYour signal bot is working correctly.\nPairs: ' + CONFIG.PAIRS.join(', ') + '\nStrategy: 1H EMA 50 Crossover on 15m\nRisk:Reward = 1:3',
      parse_mode: 'Markdown'
    }),
    muteHttpExceptions: true
  });
  Logger.log('Test message sent!');
}
