# Crypto Trading Scanner

Real-time cryptocurrency trading scanner using **1H EMA 50 Crossover Strategy** confirmed on the 15-minute timeframe.

## Features

- **Scanner** - Live signals for BTC, ETH, XRP, LINK with entry/TP/SL levels
- **Gainers & Losers** - Top movers by volume with trend detection
- **Trade Result** - Performance stats, ROI/PnL charts, position history for main pairs
- **Trade Result 2** - Same analytics for gainer/loser coins
- **Signal Filter** - Whale detection with volume spike analysis
- **Chart** - Interactive candlestick charts with EMA overlay and buy/sell markers
- **Backtest** - Historical strategy backtesting with $1000 starting balance

## Strategy

- **Entry**: 1H candle closes above/below EMA 50, confirmed by 15m candle close
- **TP/SL**: 1:3 risk-reward ratio (1% Stop Loss, 3% Take Profit)
- **Pairs**: BTC/USDT, ETH/USDT, XRP/USDT, LINK/USDT + top gainers/losers

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: Vanilla HTML/CSS/JS, Lightweight Charts
- **Data**: Binance Public API (no API key needed)

## Run Locally

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser.

## Deploy on Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) and create a **New Web Service**
3. Connect your GitHub repository
4. Use these settings:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node
5. Click **Deploy**

No environment variables needed - the app uses Binance's public API.

## Screenshots

Dark-themed UI with live price data, interactive charts, and detailed trade analytics.
