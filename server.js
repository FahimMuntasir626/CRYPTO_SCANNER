const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const PAIRS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'LINKUSDT'];

async function fetchKlines(symbol, interval, limit = 1000) {
  if (limit <= 1000) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
      quoteVolume: parseFloat(k[7]),
      trades: k[8]
    }));
  }

  // Fetch in batches for larger requests
  let allData = [];
  let endTime = Date.now();
  let remaining = limit;

  while (remaining > 0) {
    const batchSize = Math.min(remaining, 1000);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${batchSize}&endTime=${endTime}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.length) break;
    const parsed = data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
      quoteVolume: parseFloat(k[7]),
      trades: k[8]
    }));
    allData = parsed.concat(allData);
    endTime = data[0][0] - 1;
    remaining -= batchSize;
  }
  return allData;
}

async function fetch24hTicker(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;
  const res = await fetch(url);
  return res.json();
}

function calculateEMA(data, period) {
  const ema = [];
  const multiplier = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i].close;
  }
  ema[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) {
    ema[i] = (data[i].close - ema[i - 1]) * multiplier + ema[i - 1];
  }
  return ema;
}

function calculateATR(data, period) {
  const atr = [];
  const tr = [];
  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      tr[i] = data[i].high - data[i].low;
    } else {
      tr[i] = Math.max(
        data[i].high - data[i].low,
        Math.abs(data[i].high - data[i - 1].close),
        Math.abs(data[i].low - data[i - 1].close)
      );
    }
  }
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += tr[i];
  }
  atr[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function calculateSuperTrend(data, period, multiplier) {
  const atr = calculateATR(data, period);
  const superTrend = [];
  const direction = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period) {
      superTrend[i] = 0;
      direction[i] = 1;
      continue;
    }

    const basicUpperBand = (data[i].high + data[i].low) / 2 + multiplier * atr[i];
    const basicLowerBand = (data[i].high + data[i].low) / 2 - multiplier * atr[i];

    let finalUpperBand = basicUpperBand;
    let finalLowerBand = basicLowerBand;

    if (i > period) {
      finalUpperBand = basicUpperBand < (superTrend[i - 1] === superTrend[i - 1] ? superTrend[i - 1] : basicUpperBand) || data[i - 1].close > (superTrend[i - 1] || 0)
        ? basicUpperBand
        : Math.min(basicUpperBand, superTrend[i - 1] || basicUpperBand);

      finalLowerBand = basicLowerBand > (superTrend[i - 1] === superTrend[i - 1] ? superTrend[i - 1] : basicLowerBand) || data[i - 1].close < (superTrend[i - 1] || 0)
        ? basicLowerBand
        : Math.max(basicLowerBand, superTrend[i - 1] || basicLowerBand);
    }

    if (direction[i - 1] === 1) {
      if (data[i].close < finalLowerBand) {
        direction[i] = -1;
        superTrend[i] = finalUpperBand;
      } else {
        direction[i] = 1;
        superTrend[i] = finalLowerBand;
      }
    } else {
      if (data[i].close > finalUpperBand) {
        direction[i] = 1;
        superTrend[i] = finalLowerBand;
      } else {
        direction[i] = -1;
        superTrend[i] = finalUpperBand;
      }
    }
  }
  return { superTrend, direction };
}

function generateSignals(data1h, data15m) {
  const ema50_1h = calculateEMA(data1h, 50);
  const ema50_15m = calculateEMA(data15m, 50);

  const signals = [];
  const lastIdx1h = data1h.length - 1;

  const trend1h = data1h[lastIdx1h].close > ema50_1h[lastIdx1h] ? 'BULLISH' : 'BEARISH';

  // Build a map: for each hour, store the 1H EMA and whether 1H closed above/below
  const hourlyData = {};
  for (let h = 50; h < data1h.length; h++) {
    if (!ema50_1h[h]) continue;
    hourlyData[data1h[h].time] = {
      ema: ema50_1h[h],
      above: data1h[h].close > ema50_1h[h]
    };
  }

  let currentHourData = null;
  let lastSignalType = null;
  let lastSignalTime = 0;
  const minGapCandles = 8; // Minimum 2 hours between signals to avoid whipsaws

  for (let i = 1; i < data15m.length; i++) {
    // Update the 1H reference when a new hour starts
    const candleHour = Math.floor(data15m[i].time / 3600000) * 3600000;
    if (hourlyData[candleHour]) {
      currentHourData = hourlyData[candleHour];
    }
    if (!currentHourData) continue;

    const currClose = data15m[i].close;
    const ema1h = currentHourData.ema;
    const hourAbove = currentHourData.above;

    // BUY: 1H closed above EMA 50 AND 15m candle closes above 1H EMA (confirmed)
    if (hourAbove && currClose > ema1h && lastSignalType !== 'BUY' && (i - lastSignalTime) >= minGapCandles) {
      signals.push({ index: i, type: 'BUY', price: currClose, time: data15m[i].time });
      lastSignalType = 'BUY';
      lastSignalTime = i;
    }
    // SELL: 1H closed below EMA 50 AND 15m candle closes below 1H EMA (confirmed)
    if (!hourAbove && currClose < ema1h && lastSignalType !== 'SELL' && (i - lastSignalTime) >= minGapCandles) {
      signals.push({ index: i, type: 'SELL', price: currClose, time: data15m[i].time });
      lastSignalType = 'SELL';
      lastSignalTime = i;
    }
  }

  return { signals, trend1h, ema50_1h, ema50_15m };
}

function runBacktest(data15m, signals) {
  let balance = 1000;
  const trades = [];
  const slPercent = 0.01; // 1% Stop Loss
  const tpPercent = 0.03; // 3% Take Profit (1:3 ratio)

  for (const signal of signals) {
    const entry = signal.price;
    const entryIdx = signal.index;
    let sl, tp;

    if (signal.type === 'BUY') {
      sl = entry * (1 - slPercent);
      tp = entry * (1 + tpPercent);
    } else {
      sl = entry * (1 + slPercent);
      tp = entry * (1 - tpPercent);
    }

    let exitPrice = null;
    let exitTime = null;
    let hit = null;

    // Walk forward candle by candle to check TP/SL hit
    for (let j = entryIdx + 1; j < data15m.length; j++) {
      const candle = data15m[j];

      if (signal.type === 'BUY') {
        // Check SL first (worst case)
        if (candle.low <= sl) {
          exitPrice = sl;
          exitTime = candle.time;
          hit = 'SL';
          break;
        }
        // Check TP
        if (candle.high >= tp) {
          exitPrice = tp;
          exitTime = candle.time;
          hit = 'TP';
          break;
        }
      } else {
        // Check SL first (worst case)
        if (candle.high >= sl) {
          exitPrice = sl;
          exitTime = candle.time;
          hit = 'SL';
          break;
        }
        // Check TP
        if (candle.low <= tp) {
          exitPrice = tp;
          exitTime = candle.time;
          hit = 'TP';
          break;
        }
      }
    }

    if (exitPrice && hit) {
      let pnl = 0;
      if (signal.type === 'BUY') {
        pnl = ((exitPrice - entry) / entry) * balance;
      } else {
        pnl = ((entry - exitPrice) / entry) * balance;
      }
      balance += pnl;
      trades.push({
        type: signal.type === 'BUY' ? 'LONG' : 'SHORT',
        entry,
        exit: exitPrice,
        sl,
        tp,
        hit,
        pnl: pnl.toFixed(2),
        entryTime: signal.time,
        exitTime
      });
    }
  }

  const winTrades = trades.filter(t => t.hit === 'TP');
  const lossTrades = trades.filter(t => t.hit === 'SL');
  const avgWin = winTrades.length > 0 ? (winTrades.reduce((s, t) => s + parseFloat(t.pnl), 0) / winTrades.length).toFixed(2) : '0';
  const avgLoss = lossTrades.length > 0 ? (lossTrades.reduce((s, t) => s + parseFloat(t.pnl), 0) / lossTrades.length).toFixed(2) : '0';
  const maxDrawdown = trades.reduce((max, t) => Math.min(max, parseFloat(t.pnl)), 0).toFixed(2);

  return {
    totalTrades: trades.length,
    winRate: trades.length > 0 ? ((winTrades.length / trades.length) * 100).toFixed(1) : 0,
    totalPnL: (balance - 1000).toFixed(2),
    finalBalance: balance.toFixed(2),
    avgWin,
    avgLoss,
    maxDrawdown,
    riskReward: '1:3',
    slPercent: '1%',
    tpPercent: '3%',
    startBalance: '1000.00',
    trades: trades.slice(-30)
  };
}

app.get('/api/scan', async (req, res) => {
  try {
    const results = [];
    for (const symbol of PAIRS) {
      const [data1h, data15m, ticker] = await Promise.all([
        fetchKlines(symbol, '1h', 1000),
        fetchKlines(symbol, '15m', 8000),
        fetch24hTicker(symbol)
      ]);

      const { signals, trend1h, ema50_15m } = generateSignals(data1h, data15m);
      const backtest = runBacktest(data15m, signals);
      const lastIdx = data15m.length - 1;

      const volumeChange = data15m.length > 20
        ? (data15m.slice(-5).reduce((s, c) => s + c.volume, 0) / 5) /
          (data15m.slice(-20, -5).reduce((s, c) => s + c.volume, 0) / 15)
        : 1;

      const priceChange24h = parseFloat(ticker.priceChangePercent);
      const quoteVolume24h = parseFloat(ticker.quoteVolume);

      const whaleScore = Math.min(100, Math.round(
        (volumeChange > 2 ? 40 : volumeChange > 1.5 ? 25 : 10) +
        (Math.abs(priceChange24h) > 5 ? 30 : Math.abs(priceChange24h) > 2 ? 20 : 5) +
        (quoteVolume24h > 1000000000 ? 30 : quoteVolume24h > 100000000 ? 20 : 10)
      ));

      // Get last signal with TP/SL levels and result
      let lastTrade = null;
      if (signals.length > 0) {
        const lastSig = signals[signals.length - 1];
        const entry = lastSig.price;
        const slPrice = lastSig.type === 'BUY' ? entry * (1 - 0.01) : entry * (1 + 0.01);
        const tpPrice = lastSig.type === 'BUY' ? entry * (1 + 0.03) : entry * (1 - 0.03);

        // Check if TP or SL was hit
        let result = 'ACTIVE';
        for (let j = lastSig.index + 1; j < data15m.length; j++) {
          const c = data15m[j];
          if (lastSig.type === 'BUY') {
            if (c.low <= slPrice) { result = 'SL HIT'; break; }
            if (c.high >= tpPrice) { result = 'TP HIT'; break; }
          } else {
            if (c.high >= slPrice) { result = 'SL HIT'; break; }
            if (c.low <= tpPrice) { result = 'TP HIT'; break; }
          }
        }

        lastTrade = {
          type: lastSig.type,
          entry: entry.toFixed(4),
          sl: slPrice.toFixed(4),
          tp: tpPrice.toFixed(4),
          currentPrice: data15m[lastIdx].close.toFixed(4),
          result,
          time: lastSig.time
        };
      }

      results.push({
        symbol,
        price: data15m[lastIdx].close,
        trend1h,
        ema50: ema50_15m[lastIdx] ? ema50_15m[lastIdx].toFixed(4) : 0,
        emaPosition: data15m[data15m.length - 1].close > parseFloat(ema50_15m[data15m.length - 1] || 0) ? 'ABOVE' : 'BELOW',
        lastSignal: signals.length > 0 ? signals[signals.length - 1] : null,
        lastTrade,
        signalCount: signals.length,
        backtest,
        volumeChange: volumeChange.toFixed(2),
        priceChange24h: priceChange24h.toFixed(2),
        quoteVolume24h: (quoteVolume24h / 1000000).toFixed(2),
        whaleScore,
        trades24h: parseInt(ticker.count)
      });
    }

    results.sort((a, b) => b.whaleScore - a.whaleScore);
    res.json({ success: true, data: results, timestamp: Date.now() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/chart/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const [data1h, data15m] = await Promise.all([
      fetchKlines(symbol, '1h', 500),
      fetchKlines(symbol, '15m', 500)
    ]);

    const { signals, ema50_15m, ema50_1h } = generateSignals(data1h, data15m);

    res.json({
      success: true,
      candles: data15m,
      ema50: ema50_15m,
      signals
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/gainers-losers', async (req, res) => {
  try {
    // Fetch all USDT tickers
    const tickerRes = await fetch('https://api.binance.com/api/v3/ticker/24hr');
    const allTickers = await tickerRes.json();

    // Filter USDT pairs with good volume
    const usdtPairs = allTickers
      .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 10000000)
      .map(t => ({
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        priceChange: parseFloat(t.priceChangePercent),
        volume24h: parseFloat(t.quoteVolume),
        high24h: parseFloat(t.highPrice),
        low24h: parseFloat(t.lowPrice),
        trades: parseInt(t.count)
      }));

    // Top gainers
    const gainers = [...usdtPairs]
      .sort((a, b) => b.priceChange - a.priceChange)
      .slice(0, 10);

    // Top losers
    const losers = [...usdtPairs]
      .sort((a, b) => a.priceChange - b.priceChange)
      .slice(0, 10);

    // For top 5 gainers and losers, fetch 1H data and calculate entry/TP/SL
    const analyzeCoins = [...gainers.slice(0, 5), ...losers.slice(0, 5)];
    const analyzed = [];

    for (const coin of analyzeCoins) {
      try {
        const [data1h, data15m] = await Promise.all([
          fetchKlines(coin.symbol, '1h', 100),
          fetchKlines(coin.symbol, '15m', 100)
        ]);

        const ema50_1h = calculateEMA(data1h, 50);
        const lastIdx1h = data1h.length - 1;
        const lastIdx15m = data15m.length - 1;

        const ema1hVal = ema50_1h[lastIdx1h] || 0;
        const trend = data1h[lastIdx1h].close > ema1hVal ? 'BULLISH' : 'BEARISH';
        const priceAboveEma = data15m[lastIdx15m].close > ema1hVal;

        // Calculate entry based on trend
        let entry = null, tp = null, sl = null, direction = null;

        if (trend === 'BULLISH' && priceAboveEma) {
          direction = 'BUY';
          entry = data15m[lastIdx15m].close;
          sl = entry * (1 - 0.01);
          tp = entry * (1 + 0.03);
        } else if (trend === 'BEARISH' && !priceAboveEma) {
          direction = 'SELL';
          entry = data15m[lastIdx15m].close;
          sl = entry * (1 + 0.01);
          tp = entry * (1 - 0.03);
        }

        // Volume trend (last 5 candles vs previous 10)
        const recentVol = data15m.slice(-5).reduce((s, c) => s + c.volume, 0) / 5;
        const prevVol = data15m.slice(-15, -5).reduce((s, c) => s + c.volume, 0) / 10;
        const volTrend = prevVol > 0 ? (recentVol / prevVol) : 1;

        analyzed.push({
          ...coin,
          trend,
          ema50: ema1hVal.toFixed(4),
          direction,
          entry: entry ? entry.toFixed(4) : null,
          tp: tp ? tp.toFixed(4) : null,
          sl: sl ? sl.toFixed(4) : null,
          volTrend: volTrend.toFixed(2),
          strength: Math.abs(coin.priceChange) > 5 ? 'STRONG' : Math.abs(coin.priceChange) > 2 ? 'MODERATE' : 'WEAK'
        });
      } catch (e) {
        analyzed.push({ ...coin, trend: 'N/A', direction: null, entry: null, tp: null, sl: null, volTrend: '1.00', strength: 'N/A' });
      }
    }

    res.json({
      success: true,
      gainers: analyzed.slice(0, 5),
      losers: analyzed.slice(5, 10),
      allGainers: gainers,
      allLosers: losers
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/results', async (req, res) => {
  try {
    const now = Date.now();
    const d7 = now - 7 * 24 * 60 * 60 * 1000;
    const d30 = now - 30 * 24 * 60 * 60 * 1000;

    const allClosed = [];
    const allActive = [];
    const perPair = {};

    for (const symbol of PAIRS) {
      const [data1h, data15m] = await Promise.all([
        fetchKlines(symbol, '1h', 1000),
        fetchKlines(symbol, '15m', 8000)
      ]);
      const { signals } = generateSignals(data1h, data15m);
      const lastIdx = data15m.length - 1;
      const currentPrice = data15m[lastIdx].close;

      for (const signal of signals) {
        const entry = signal.price;
        const slPrice = signal.type === 'BUY' ? entry * (1 - 0.01) : entry * (1 + 0.01);
        const tpPrice = signal.type === 'BUY' ? entry * (1 + 0.03) : entry * (1 - 0.03);
        let closed = false;

        for (let j = signal.index + 1; j < data15m.length; j++) {
          const c = data15m[j];
          if (signal.type === 'BUY') {
            if (c.low <= slPrice) { allClosed.push({ symbol, type: 'LONG', entry, exit: slPrice, tp: tpPrice, sl: slPrice, hit: 'SL', pnl: -0.01, time: signal.time, exitTime: c.time }); closed = true; break; }
            if (c.high >= tpPrice) { allClosed.push({ symbol, type: 'LONG', entry, exit: tpPrice, tp: tpPrice, sl: slPrice, hit: 'TP', pnl: 0.03, time: signal.time, exitTime: c.time }); closed = true; break; }
          } else {
            if (c.high >= slPrice) { allClosed.push({ symbol, type: 'SHORT', entry, exit: slPrice, tp: tpPrice, sl: slPrice, hit: 'SL', pnl: -0.01, time: signal.time, exitTime: c.time }); closed = true; break; }
            if (c.low <= tpPrice) { allClosed.push({ symbol, type: 'SHORT', entry, exit: tpPrice, tp: tpPrice, sl: slPrice, hit: 'TP', pnl: 0.03, time: signal.time, exitTime: c.time }); closed = true; break; }
          }
        }

        if (!closed) {
          const unrealizedPnl = signal.type === 'BUY'
            ? ((currentPrice - entry) / entry * 100).toFixed(2)
            : ((entry - currentPrice) / entry * 100).toFixed(2);
          allActive.push({ symbol, type: signal.type === 'BUY' ? 'LONG' : 'SHORT', entry, tp: tpPrice, sl: slPrice, currentPrice, unrealizedPnl, time: signal.time });
        }
      }
    }

    // Per-pair ROI and PnL
    for (const symbol of PAIRS) {
      const pairTrades = allClosed.filter(t => t.symbol === symbol);
      const wins = pairTrades.filter(t => t.hit === 'TP').length;
      const losses = pairTrades.filter(t => t.hit === 'SL').length;
      const roi = pairTrades.reduce((s, t) => s + t.pnl, 0) * 100;
      let balance = 1000;
      for (const t of pairTrades) { balance += t.pnl * balance; }
      perPair[symbol] = { roi: roi.toFixed(2), pnl: (balance - 1000).toFixed(2), wins, losses, total: pairTrades.length };
    }

    // Stats calculator
    function getMetrics(arr) {
      const wins = arr.filter(t => t.hit === 'TP');
      const losses = arr.filter(t => t.hit === 'SL');
      const pnlArr = arr.map(t => t.pnl);
      const totalPnl = pnlArr.reduce((s, v) => s + v, 0);
      const avgPnl = pnlArr.length > 0 ? totalPnl / pnlArr.length : 0;
      const stdDev = pnlArr.length > 1 ? Math.sqrt(pnlArr.reduce((s, v) => s + Math.pow(v - avgPnl, 2), 0) / (pnlArr.length - 1)) : 0;
      const sharpe = stdDev > 0 ? (avgPnl / stdDev).toFixed(2) : '0';

      let balance = 1000;
      let peak = 1000;
      let maxDd = 0;
      for (const t of arr) {
        balance += t.pnl * balance;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDd) maxDd = dd;
      }

      return {
        totalPositions: arr.length,
        profitablePositions: wins.length,
        winRate: arr.length > 0 ? ((wins.length / arr.length) * 100).toFixed(1) : '0',
        roi: (totalPnl * 100).toFixed(2),
        pnl: (balance - 1000).toFixed(2),
        sharpeRatio: sharpe,
        maxDrawdown: (maxDd * 100).toFixed(2),
        profitFactor: losses.length > 0 ? ((wins.length * 0.03) / (losses.length * 0.01)).toFixed(2) : 'N/A',
        finalBalance: balance.toFixed(2)
      };
    }

    const trades7d = allClosed.filter(t => t.exitTime >= d7);
    const trades30d = allClosed.filter(t => t.exitTime >= d30);

    // Build time-series for line charts
    const sorted = [...allClosed].sort((a, b) => a.exitTime - b.exitTime);
    let cumRoi = 0, cumBal = 1000;
    const roiTimeSeries = [];
    const pnlTimeSeries = [];
    for (const t of sorted) {
      cumRoi += t.pnl * 100;
      cumBal += t.pnl * cumBal;
      const ts = Math.floor(t.exitTime / 1000);
      roiTimeSeries.push({ time: ts, value: parseFloat(cumRoi.toFixed(2)) });
      pnlTimeSeries.push({ time: ts, value: parseFloat((cumBal - 1000).toFixed(2)) });
    }

    res.json({
      success: true,
      performance: {
        days7: getMetrics(trades7d),
        days30: getMetrics(trades30d)
      },
      perPair,
      activePositions: allActive,
      history: {
        wins: allClosed.filter(t => t.hit === 'TP').slice(-50),
        losses: allClosed.filter(t => t.hit === 'SL').slice(-50)
      },
      roiTimeSeries,
      pnlTimeSeries
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/results2', async (req, res) => {
  try {
    const now = Date.now();
    const d7 = now - 7 * 24 * 60 * 60 * 1000;
    const d30 = now - 30 * 24 * 60 * 60 * 1000;

    // Fetch top gainers and losers
    const tickerRes = await fetch('https://api.binance.com/api/v3/ticker/24hr');
    const allTickers = await tickerRes.json();
    const usdtPairs = allTickers
      .filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 50000000)
      .map(t => ({ symbol: t.symbol, priceChange: parseFloat(t.priceChangePercent), volume: parseFloat(t.quoteVolume) }));

    const topGainers = [...usdtPairs].sort((a, b) => b.priceChange - a.priceChange).slice(0, 5);
    const topLosers = [...usdtPairs].sort((a, b) => a.priceChange - b.priceChange).slice(0, 5);
    const movers = [...topGainers, ...topLosers];

    const allClosed = [];
    const allActive = [];
    const perCoin = {};

    for (const mover of movers) {
      try {
        const [data1h, data15m] = await Promise.all([
          fetchKlines(mover.symbol, '1h', 500),
          fetchKlines(mover.symbol, '15m', 2000)
        ]);
        const { signals } = generateSignals(data1h, data15m);
        const lastIdx = data15m.length - 1;
        const currentPrice = data15m[lastIdx].close;

        const coinTrades = [];

        for (const signal of signals) {
          const entry = signal.price;
          const slPrice = signal.type === 'BUY' ? entry * (1 - 0.01) : entry * (1 + 0.01);
          const tpPrice = signal.type === 'BUY' ? entry * (1 + 0.03) : entry * (1 - 0.03);
          let closed = false;

          for (let j = signal.index + 1; j < data15m.length; j++) {
            const c = data15m[j];
            if (signal.type === 'BUY') {
              if (c.low <= slPrice) { const t = { symbol: mover.symbol, type: 'LONG', entry, exit: slPrice, tp: tpPrice, sl: slPrice, hit: 'SL', pnl: -0.01, time: signal.time, exitTime: c.time }; allClosed.push(t); coinTrades.push(t); closed = true; break; }
              if (c.high >= tpPrice) { const t = { symbol: mover.symbol, type: 'LONG', entry, exit: tpPrice, tp: tpPrice, sl: slPrice, hit: 'TP', pnl: 0.03, time: signal.time, exitTime: c.time }; allClosed.push(t); coinTrades.push(t); closed = true; break; }
            } else {
              if (c.high >= slPrice) { const t = { symbol: mover.symbol, type: 'SHORT', entry, exit: slPrice, tp: tpPrice, sl: slPrice, hit: 'SL', pnl: -0.01, time: signal.time, exitTime: c.time }; allClosed.push(t); coinTrades.push(t); closed = true; break; }
              if (c.low <= tpPrice) { const t = { symbol: mover.symbol, type: 'SHORT', entry, exit: tpPrice, tp: tpPrice, sl: slPrice, hit: 'TP', pnl: 0.03, time: signal.time, exitTime: c.time }; allClosed.push(t); coinTrades.push(t); closed = true; break; }
            }
          }

          if (!closed) {
            const unrealizedPnl = signal.type === 'BUY'
              ? ((currentPrice - entry) / entry * 100).toFixed(2)
              : ((entry - currentPrice) / entry * 100).toFixed(2);
            allActive.push({ symbol: mover.symbol, type: signal.type === 'BUY' ? 'LONG' : 'SHORT', entry, tp: tpPrice, sl: slPrice, currentPrice, unrealizedPnl, time: signal.time });
          }
        }

        const wins = coinTrades.filter(t => t.hit === 'TP').length;
        const losses = coinTrades.filter(t => t.hit === 'SL').length;
        const roi = coinTrades.reduce((s, t) => s + t.pnl, 0) * 100;
        let bal = 1000;
        for (const t of coinTrades) { bal += t.pnl * bal; }
        perCoin[mover.symbol] = { roi: roi.toFixed(2), pnl: (bal - 1000).toFixed(2), wins, losses, total: coinTrades.length, priceChange: mover.priceChange.toFixed(2) };
      } catch (e) {}
    }

    function getMetrics(arr) {
      const wins = arr.filter(t => t.hit === 'TP');
      const losses = arr.filter(t => t.hit === 'SL');
      const pnlArr = arr.map(t => t.pnl);
      const totalPnl = pnlArr.reduce((s, v) => s + v, 0);
      const avgPnl = pnlArr.length > 0 ? totalPnl / pnlArr.length : 0;
      const stdDev = pnlArr.length > 1 ? Math.sqrt(pnlArr.reduce((s, v) => s + Math.pow(v - avgPnl, 2), 0) / (pnlArr.length - 1)) : 0;
      const sharpe = stdDev > 0 ? (avgPnl / stdDev).toFixed(2) : '0';
      let balance = 1000; let peak = 1000; let maxDd = 0;
      for (const t of arr) { balance += t.pnl * balance; if (balance > peak) peak = balance; const dd = (peak - balance) / peak; if (dd > maxDd) maxDd = dd; }
      return {
        totalPositions: arr.length, profitablePositions: wins.length,
        winRate: arr.length > 0 ? ((wins.length / arr.length) * 100).toFixed(1) : '0',
        roi: (totalPnl * 100).toFixed(2), pnl: (balance - 1000).toFixed(2),
        sharpeRatio: sharpe, maxDrawdown: (maxDd * 100).toFixed(2),
        profitFactor: losses.length > 0 ? ((wins.length * 0.03) / (losses.length * 0.01)).toFixed(2) : 'N/A',
        finalBalance: balance.toFixed(2)
      };
    }

    const trades7d = allClosed.filter(t => t.exitTime >= d7);
    const trades30d = allClosed.filter(t => t.exitTime >= d30);

    // Build time-series for line charts
    const sorted = [...allClosed].sort((a, b) => a.exitTime - b.exitTime);
    let cumRoi = 0, cumBal = 1000;
    const roiTimeSeries = [];
    const pnlTimeSeries = [];
    for (const t of sorted) {
      cumRoi += t.pnl * 100;
      cumBal += t.pnl * cumBal;
      const ts = Math.floor(t.exitTime / 1000);
      roiTimeSeries.push({ time: ts, value: parseFloat(cumRoi.toFixed(2)) });
      pnlTimeSeries.push({ time: ts, value: parseFloat((cumBal - 1000).toFixed(2)) });
    }

    res.json({
      success: true,
      performance: { days7: getMetrics(trades7d), days30: getMetrics(trades30d) },
      perCoin,
      activePositions: allActive,
      history: {
        wins: allClosed.filter(t => t.hit === 'TP').slice(-50),
        losses: allClosed.filter(t => t.hit === 'SL').slice(-50)
      },
      roiTimeSeries,
      pnlTimeSeries
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Trading Scanner running at http://localhost:${PORT}`);
});
