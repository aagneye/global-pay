# ADR 0001: Base as the first network

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

GlobalPay needs an EVM chain where everyday payments (a 50 baht coffee) cost a tiny fraction of the payment, and where USDC is native rather than bridged. Ethereum mainnet fees are usually tens of cents and can jump to dollars when the network is busy.

## Decision

Build on **Base**, an Ethereum Layer 2. Develop on **Base Sepolia** (chainId 84532).

## Consequences

- Fees are usually under one US cent per payment.
- Circle issues USDC natively on Base and supports EIP-3009 (see ADR 0002).
- The contracts are standard EVM Solidity, so they can be redeployed to Ethereum mainnet, Arbitrum or Polygon without changes.
- Base relies on a single sequencer run by Coinbase. Sequencer downtime pauses payments, and the app must show a clear "network unavailable" state.
- USDT on Base is thin, so USDT support will come later on another chain or through a swap.
