# 🤖 AI Trading Bot

> Sophisticated cryptocurrency trading bot leveraging AI to make trading decisions and execute them on Hyperliquid exchange.

This project was inspired by nof1.ai's Alpha Arena concept, where multiple AI models compete with identical market data inputs in a controlled environment.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/Node.js-22%2B-brightgreen)](https://nodejs.org/)

## 📋 Table of Contents

-   [Features](#features)
-   [Architecture](#architecture)
-   [Requirements](#requirements)
-   [Installation](#installation)
-   [Configuration](#configuration)
-   [Usage](#usage)
-   [Risk Disclaimer](#important-risk-disclaimer)
-   [License](#license)

## ✨ Features

-   **🧠 AI-Powered Trading Decisions**: Uses AI to analyze market data and generate trading signals
-   **🚀 Automated Trade Execution**: Seamlessly places orders on Hyperliquid with TP/SL management
-   **🛡️ Risk Management System**: Configurable position sizing, leverage limits, and risk parameters
-   **📊 Technical Analysis**: Built-in indicators (EMA, MACD, RSI, ATR)
-   **🔄 Multiple Position Management Policies**: Options for handling existing positions and conflicting signals
-   **🔁 Retry Mechanisms**: Resilient API communication with automatic retries
-   **📝 Advanced Order Types**: Bracket orders, aggressive limit entries with fallbacks
-   **💾 MongoDB Integration**: Storage of trading decisions and performance metrics

## 🏗️ Architecture

The trading bot follows a modular architecture:

1. **Data Collection** (`market.ts`): Gathers OHLCV data, funding rates, and order book depth
2. **Technical Analysis** (`indicators.ts`): Calculates indicators (EMA, MACD, RSI, ATR)
3. **Prompt Generation** (`prompt.ts`): Formats market data for AI consumption
4. **AI Decision** (`ai.ts`): Queries AI model for trading decisions
5. **Trade Execution** (`execute.ts`): Translates AI decisions into exchange orders
6. **Risk Management**: Enforces position size limits, max leverage, and proper TP/SL placement
7. **Scheduled Operation**: Runs on configurable intervals using cron jobs

## 🔧 Requirements

-   Node.js 22+
-   MongoDB (option)
-   API access
-   Hyperliquid account with API keys

## 📥 Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/AI-Trading-Bot.git

# Navigate to the project directory
cd AI-Trading-Bot

# Install dependencies
npm install
```

## ⚙️ Configuration

Key configuration parameters in `.env`:

```env
# API Keys
HL_API_KEY=your_api_key_here
HL_API_SECRET=your_api_secret_here

# Environment
HL_TESTNET=true  # Set to false for production

# Trading Parameters
MAX_LEVERAGE=10
POSITION_SIZE=0.1  # BTC
STOP_LOSS_PERCENT=2
TAKE_PROFIT_PERCENT=6

# Schedule
CRON_SCHEDULE="*/15 * * * *"  # Run every 15 minutes
```

## 🚀 Usage

The bot operates in two modes:

-   **Test mode**: When `HL_TESTNET=true`, the bot runs immediately after startup
-   **Production mode**: When `HL_TESTNET=false`, the bot follows the cron schedule

Monitor the console output for trading decisions and actions.

## ⚠️ Important Risk Disclaimer

> **This is an educational/experimental project. Use at your own risk.**

-   This bot is not financial advice and has no guaranteed profitability
-   Always start with small amounts when testing or testnet
-   Never use funds you cannot afford to lose
-   The bot may contain bugs or unexpected behaviors
-   Cryptocurrency markets are extremely volatile

## 📄 License

MIT License - See LICENSE file for details

---

_This project is a proof-of-concept inspired by nof1.ai's Alpha Arena and is not affiliated with or endorsed by nof1.ai or Hyperliquid._
