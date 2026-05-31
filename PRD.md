**Product Requirements Document (PRD)**

**Product Feature:** Daily Prediction Streak  
**Version:** 1.0  
**Date:** May 31, 2026  
**Product:** [Your Prediction Market Platform] – AI/Tech + Crypto Vertical  

### 1. Overview

**Daily Prediction Streak** is a gamified retention system designed to turn sporadic prediction trading into a daily habit. Users receive a set of simple binary prediction markets every day, build consecutive streaks, earn multipliers, compete on leaderboards, and win weekly prizes.

The feature sits as a **lightweight gamification layer** on top of the core mint/redeem prediction market flow, significantly improving user retention, daily active users (DAU), and liquidity in the early stage.

### 2. Objectives

**Business Objectives:**
- Increase DAU by 3x within 3 months of launch
- Improve 7-day retention from <25% to >45%
- Bootstrap liquidity through high-frequency, low-complexity daily markets
- Create viral growth through social sharing of streaks and badges

**User Objectives:**
- Provide fun, low-effort daily engagement
- Reward consistency and accuracy
- Give users a clear sense of progress and competition

### 3. Target Users

- Primary: Crypto degens and AI enthusiasts (18-35 years old)
- Secondary: New users looking for an easy entry point into prediction markets
- Behavior: Mobile-first, enjoy gamification, responsive to streaks, leaderboards, and rewards

### 4. Key Features

#### 4.1 Daily Binary Markets
- 5 fixed daily binary markets refreshed every 24 hours (UTC or Bangkok time)
- Examples:
  - Will BTC close higher than current price today?
  - Will ETH close higher than current price today?
  - Will there be any major AI funding announcement (> $50M) today?
  - Will Grok / Claude / GPT release any news or update today?
  - Will Total Crypto Market Cap increase today?

- Each market: Yes/No only, simple 1-tap selection
- Market duration: 24 hours (closes at midnight UTC)

#### 4.2 Streak System
- **Current Streak**: Number of consecutive days the user correctly predicted **all** daily markets
- **Longest Streak**: All-time best
- **Streak Multipliers** (applied to winnings):
  - 3 days → +10%
  - 7 days → +30%
  - 14 days → +70%
  - 30 days → +150%
- Streak breaks if user misses even 1 market or doesn’t participate in a day

#### 4.3 Leaderboards
- Global Weekly Leaderboard
- National Leaderboards (Thailand, Indonesia, India, Vietnam, etc.)
- AI Forecaster Leaderboard
- Friends / Following Leaderboard

#### 4.4 Weekly Prize Pool
- Fixed + variable prize pool every week (e.g. $5,000 – $25,000 USDT)
- Distribution:
  - Top 10 on Global Leaderboard
  - Top 3 per country
  - Special bonuses for longest active streaks
- Can include sponsor pools from crypto/AI projects

#### 4.5 Achievement & NFT Badges
- On-chain NFT badges minted for milestones:
  - Flame Streak Series (7, 14, 30, 60 days)
  - Perfect Week
  - AI Oracle (high accuracy on AI markets)
  - Legendary Predictor (rare)
- Badges are tradable / displayable on profile

#### 4.6 Social & Virality Features
- One-tap share streak to X/Twitter with platform branding
- Follow top forecasters
- Copy-trade button on leaderboard
- Social graph showing “Manager-to-Manager” follows

### 5. User Flows

**Daily Flow:**
1. User opens app → sees “Your Daily Predictions” card
2. Taps to predict all 5 binaries (can do in <30 seconds)
3. Submits → position is minted
4. Receives streak status and XP
5. Next day: Push notification “Day 12 of your streak — don’t break it!”

**End of Day:**
- Markets resolve automatically
- Correct predictions = streak continues
- Winnings + multiplier credited

### 6. Technical Requirements

- **Frontend:** Progressive Web App (PWA) – installable, push notifications enabled
- **Backend:** Daily market generation logic (can be semi-automated)
- **Resolution:** Oracle + admin fallback for daily markets
- **Integration:** Must connect to existing mint/redeem smart contracts
- **Wallet:** Supports wallet connection + gasless transactions where possible
- **Analytics:** Track streak length, participation rate, retention cohorts

### 7. Success Metrics (KPIs)

**Primary:**
- Daily Active Users (DAU)
- 7-day & 30-day Retention Rate
- Average daily predictions per user

**Secondary:**
- Average streak length
- Weekly prize pool participation rate
- NFT badge mint rate
- Organic shares on social media

**Target (First 90 days):**
- 40%+ of active users participate in Daily Streak
- Average streak > 5 days

### 8. Risks & Dependencies

**Risks:**
- Low daily market accuracy may frustrate users → balance market difficulty
- Prize pool cost → start small and optimize
- Regulatory perception (mitigated by framing as forecasting game)

**Dependencies:**
- Working prediction market core (mint/redeem)
- Oracle system for fast resolution
- Push notification infrastructure
- NFT minting contract

---
