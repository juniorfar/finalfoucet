import { Router, Response } from 'express';
import { z } from 'zod';
import { User } from '../models/User.js';
import { PayoutRequest } from '../models/PayoutRequest.js';
import { authenticateJWT, AuthRequest } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import crypto from 'crypto';

const router = Router();

const PayoutSchema = z.object({
  provider: z.enum(['faucetpay', 'cwallet']).default('faucetpay'),
  currency: z.enum(['BTC', 'USDT']).default('BTC'),
  amount: z.number().min(0.0001, 'Minimum withdrawal amount required'),
  walletAddress: z.string().min(3, 'Valid wallet address or email is required'),
});

// POST /api/payout/request
router.post('/request', authenticateJWT, validateBody(PayoutSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { provider, currency, amount, walletAddress } = req.body;
    const userId = req.user?.userId;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Not Found', message: 'User not found' });
    }

    let withdrawValueUsd = 0;
    let receiveAmount = '';

    if (currency === 'BTC') {
      const amountSats = Math.round(amount);
      if (amountSats < 100) {
        return res.status(400).json({ error: 'Min Withdrawal', message: 'Minimum BTC withdrawal is 100 sats' });
      }
      if (user.satsBalance < amountSats) {
        return res.status(400).json({
          error: 'Insufficient Balance',
          message: `You have ${user.satsBalance} sats, but requested ${amountSats} sats.`,
        });
      }
      withdrawValueUsd = Number(((amountSats / 100000000) * 96000).toFixed(4));
      receiveAmount = `${amountSats} SATS (~$${withdrawValueUsd.toFixed(2)})`;
      user.satsBalance -= amountSats;
    } else {
      // USDT
      const amountUsdt = Number(amount.toFixed(4));
      if (amountUsdt < 0.05) {
        return res.status(400).json({ error: 'Min Withdrawal', message: 'Minimum USDT withdrawal is 0.05 USDT' });
      }
      if ((user.usdtBalance || 0) < amountUsdt) {
        return res.status(400).json({
          error: 'Insufficient Balance',
          message: `You have ${(user.usdtBalance || 0).toFixed(4)} USDT, but requested ${amountUsdt} USDT.`,
        });
      }
      withdrawValueUsd = amountUsdt;
      receiveAmount = `${amountUsdt.toFixed(4)} USDT ($${amountUsdt.toFixed(2)})`;
      user.usdtBalance -= amountUsdt;
    }

    if (walletAddress && walletAddress !== user.walletAddress) {
      user.walletAddress = walletAddress;
    }
    await user.save();

    let txHash = '';
    let status: 'completed' | 'failed' | 'pending' = 'completed';
    let isSimulated = false;
    let apiErrorMessage = '';

    const faucetApiKey = process.env.FAUCETPAY_API_KEY || process.env.FAUCETPAY_WEBHOOK_SECRET;
    const cwalletApiKey = process.env.CWALLET_API_KEY;

    if (provider === 'faucetpay' && faucetApiKey) {
      try {
        // FaucetPay API requires URL-encoded form data (POST to /api/v1/send)
        const params = new URLSearchParams();
        params.append('api_key', faucetApiKey.trim());
        params.append('to', walletAddress.trim());
        params.append('amount', currency === 'BTC' ? String(Math.round(amount)) : String(amount));
        params.append('currency', currency === 'BTC' ? 'BTC' : 'USDT');
        params.append('referral', 'false');

        const fpResponse = await fetch('https://faucetpay.io/api/v1/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
        });

        const fpData: any = await fpResponse.json().catch(() => null);

        if (fpResponse.ok && fpData && (fpData.status === 200 || fpData.status === '200') && (fpData.payout_id || fpData.txid || fpData.payout_user_hash)) {
          txHash = fpData.payout_id ? `fp_${fpData.payout_id}` : (fpData.txid || `fp_${fpData.payout_user_hash || crypto.randomBytes(8).toString('hex')}`);
          status = 'completed';
        } else {
          status = 'failed';
          apiErrorMessage = fpData?.message || fpData?.error || `FaucetPay API error (Status ${fpResponse.status})`;
          // Refund
          if (currency === 'BTC') user.satsBalance += Math.round(amount);
          else user.usdtBalance += amount;
          await user.save();
        }
      } catch (err: any) {
        status = 'failed';
        apiErrorMessage = err.message || 'FaucetPay network connection error';
        if (currency === 'BTC') user.satsBalance += Math.round(amount);
        else user.usdtBalance += amount;
        await user.save();
      }
    } else if (provider === 'cwallet' && cwalletApiKey) {
      try {
        const cwResponse = await fetch('https://api.cwallet.com/v1/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-KEY': cwalletApiKey },
          body: JSON.stringify({
            receiver: walletAddress,
            amount: amount,
            coin: currency,
          }),
        });

        const cwData = await cwResponse.json().catch(() => null);

        if (cwResponse.ok && (cwData?.code === 0 || cwData?.status === 'success')) {
          txHash = cwData.data?.tx_id || `cw_${crypto.randomBytes(8).toString('hex')}`;
          status = 'completed';
        } else {
          status = 'failed';
          apiErrorMessage = cwData?.message || `Cwallet API error ${cwResponse.status}`;
          if (currency === 'BTC') user.satsBalance += Math.round(amount);
          else user.usdtBalance += amount;
          await user.save();
        }
      } catch (err: any) {
        status = 'failed';
        apiErrorMessage = err.message || 'Cwallet connection failed';
        if (currency === 'BTC') user.satsBalance += Math.round(amount);
        else user.usdtBalance += amount;
        await user.save();
      }
    } else {
      // Test Mode Simulation
      isSimulated = true;
      const prefix = provider === 'cwallet' ? 'cw_sim_' : 'fp_sim_';
      txHash = prefix + crypto.randomBytes(8).toString('hex');
      status = 'completed';
    }

    if (status === 'failed') {
      const failedPayout = new PayoutRequest({
        userId: user._id,
        amountSats: currency === 'BTC' ? Math.round(amount) : 0,
        amountUsdt: currency === 'USDT' ? amount : 0,
        provider,
        currency,
        withdrawValueUsd,
        receiveAmount,
        walletAddress,
        status: 'failed',
        txHash: 'FAILED',
        notes: `Payout failed: ${apiErrorMessage}. Funds refunded to account.`,
      });
      await failedPayout.save();

      return res.status(400).json({
        error: 'Payout Failed',
        message: `${provider.toUpperCase()} API error: ${apiErrorMessage}. Funds refunded to your account.`,
      });
    }

    const payout = new PayoutRequest({
      userId: user._id,
      amountSats: currency === 'BTC' ? Math.round(amount) : 0,
      amountUsdt: currency === 'USDT' ? amount : 0,
      provider,
      currency,
      withdrawValueUsd,
      receiveAmount,
      walletAddress,
      status,
      txHash,
      notes: isSimulated
        ? `[TEST MODE] ${provider.toUpperCase()} API key not set in environment. Simulated payout of ${receiveAmount}.`
        : `Payout of ${receiveAmount} processed via ${provider.toUpperCase()} to ${walletAddress}`,
    });

    await payout.save();

    return res.status(201).json({
      message: isSimulated
        ? `[Test Mode] Payout request recorded. Transfer of ${receiveAmount} simulated.`
        : `Payout of ${receiveAmount} sent successfully via ${provider.toUpperCase()}!`,
      receipt: {
        payoutId: payout._id,
        provider: payout.provider,
        currency: payout.currency,
        amountSats: payout.amountSats,
        amountUsdt: payout.amountUsdt,
        withdrawValueUsd: payout.withdrawValueUsd,
        receiveAmount: payout.receiveAmount,
        walletAddress: payout.walletAddress,
        txHash: payout.txHash,
        status: payout.status,
        isSimulated,
        createdAt: payout.createdAt,
      },
      remainingSats: user.satsBalance,
      remainingUsdt: user.usdtBalance,
    });
  } catch (err: any) {
    console.error('Payout request error:', err);
    return res.status(500).json({ error: 'Server Error', message: 'Failed to process payout request' });
  }
});

// GET /api/payout/history
router.get('/history', authenticateJWT, async (req: AuthRequest, res: Response) => {
  try {
    const payouts = await PayoutRequest.find({ userId: req.user?.userId })
      .sort({ createdAt: -1 })
      .limit(20);

    return res.json({ payouts });
  } catch (err: any) {
    return res.status(500).json({ error: 'Server Error', message: 'Failed to fetch payout history' });
  }
});

// GET /api/payout/faucetpay-status (check if FaucetPay is connected & configured)
router.get('/faucetpay-status', async (_req, res) => {
  const secretKey = process.env.FAUCETPAY_API_KEY || process.env.FAUCETPAY_WEBHOOK_SECRET;
  if (!secretKey) {
    return res.json({
      connected: false,
      message: 'FaucetPay API key / Webhook secret not configured in environment',
    });
  }

  try {
    const params = new URLSearchParams();
    params.append('api_key', secretKey.trim());
    params.append('currency', 'BTC');

    const fpRes = await fetch('https://faucetpay.io/api/v1/balance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data: any = await fpRes.json().catch(() => null);

    if (fpRes.ok && data && (data.status === 200 || data.status === '200')) {
      return res.json({
        connected: true,
        currency: data.currency || 'BTC',
        balance: data.balance || data.balance_bitcoin || 0,
        message: 'FaucetPay API connected and verified',
      });
    }

    return res.json({
      connected: false,
      error: data?.message || `FaucetPay response status ${fpRes.status}`,
    });
  } catch (err: any) {
    return res.json({
      connected: false,
      error: err.message || 'Could not connect to FaucetPay API',
    });
  }
});

// POST /api/payout/faucetpay-webhook (Handle FaucetPay IPN / Webhooks)
router.post('/faucetpay-webhook', async (req, res) => {
  try {
    const payload = req.body;
    const webhookSecret = process.env.FAUCETPAY_WEBHOOK_SECRET || process.env.FAUCETPAY_API_KEY;

    console.log('[FaucetPay Webhook] Incoming callback received:', payload);

    // Verify token if token parameter is passed in webhook
    if (payload?.token && webhookSecret) {
      const computedHash = crypto
        .createHash('sha256')
        .update(payload.token + webhookSecret.trim())
        .digest('hex');

      if (payload.token_hash && payload.token_hash !== computedHash) {
        console.warn('[FaucetPay Webhook] Token verification failed');
      }
    }

    return res.status(200).json({ status: 'success', message: 'Webhook received' });
  } catch (err: any) {
    console.error('[FaucetPay Webhook] Error processing webhook:', err);
    return res.status(200).json({ status: 'error', message: err.message });
  }
});

export default router;
