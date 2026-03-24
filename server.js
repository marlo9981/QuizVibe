require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Serve the quiz page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'love_quiz_v2.html'));
});

// --------------------------------------------------------------------------
// GET /api/questions — Generate 10 quiz questions via Claude
// --------------------------------------------------------------------------
app.get('/api/questions', async (req, res) => {
  try {
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Generate exactly 10 love language quiz questions. Each question must have 5 options (a–e) that map to the 5 love languages in this exact order every time:
  a = Words of Affirmation
  b = Quality Time
  c = Receiving Gifts
  d = Acts of Service
  e = Physical Touch

Return ONLY a valid JSON array — no markdown fences, no commentary, nothing else:
[
  {
    "question": "When you feel most appreciated by a partner, it's usually because...",
    "a": "They said something kind and sincere about you",
    "b": "They gave you their full, undivided attention",
    "c": "They surprised you with something thoughtful",
    "d": "They took care of something you were dreading",
    "e": "They reached for your hand or pulled you close"
  }
]

Cover varied life moments: morning routines, stressful days, arguments, celebrations, travel, milestones, everyday gestures. Each option: 8–15 words. Be warm, specific, and relatable.`,
      }],
    });

    const message = await stream.finalMessage();
    const raw = message.content[0].text.trim();

    // Strip optional markdown fences
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    const questions = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

    res.json(questions);
  } catch (err) {
    console.error('Questions error:', err.message);
    res.status(500).json({ error: 'Failed to generate questions. Please try again.' });
  }
});

// --------------------------------------------------------------------------
// POST /api/checkout — Create a Stripe Checkout session
// Body: { scores: [words, time, gifts, service, touch] }
// --------------------------------------------------------------------------
app.post('/api/checkout', async (req, res) => {
  const { scores } = req.body;

  if (!Array.isArray(scores) || scores.length !== 5 || scores.some(s => typeof s !== 'number')) {
    return res.status(400).json({ error: 'Invalid scores payload.' });
  }

  const baseUrl = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const priceCents = parseInt(process.env.PRICE_CENTS || '499', 10);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: '💕 Love Language Analysis',
            description: 'AI-personalised love language report & relationship advice by Claude',
          },
          unit_amount: priceCents,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${baseUrl}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/`,
      metadata: {
        scores: JSON.stringify(scores),
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create payment session. Please try again.' });
  }
});

// --------------------------------------------------------------------------
// POST /api/results — Verify payment then generate Claude analysis
// Body: { sessionId: "cs_..." }
// --------------------------------------------------------------------------
app.post('/api/results', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Session ID required.' });
  }

  try {
    // Verify the Stripe payment
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed.' });
    }

    const scores = JSON.parse(session.metadata.scores);
    const [words, time, gifts, service, touch] = scores;
    const total = scores.reduce((a, b) => a + b, 0);

    const languages = [
      { name: 'Words of Affirmation', score: words, emoji: '💬' },
      { name: 'Quality Time',          score: time,    emoji: '⏰' },
      { name: 'Receiving Gifts',        score: gifts,   emoji: '🎁' },
      { name: 'Acts of Service',        score: service, emoji: '🤲' },
      { name: 'Physical Touch',         score: touch,   emoji: '❤️' },
    ].sort((a, b) => b.score - a.score);

    const primary   = languages[0];
    const secondary = languages[1];

    // Generate personalised analysis with Claude
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      messages: [{
        role: 'user',
        content: `A person just completed a love language quiz. Their scores out of ${total} total points:
- Words of Affirmation: ${words} pts
- Quality Time: ${time} pts
- Receiving Gifts: ${gifts} pts
- Acts of Service: ${service} pts
- Physical Touch: ${touch} pts

Primary love language: ${primary.name}
Secondary love language: ${secondary.name}

Write a warm, personal, insightful report. Return ONLY this JSON object — no markdown, no extra text:
{
  "headline": "A punchy, personal 6–10 word headline capturing their unique love style",
  "primary_analysis": "3–4 warm sentences deeply exploring what it means that ${primary.name} is their primary language — what they deeply crave, how they feel most seen, and what lights them up. Be specific, not generic.",
  "secondary_analysis": "2–3 sentences on how ${secondary.name} complements and enriches their primary language.",
  "receiving_tips": [
    "Specific, actionable tip 1 for how a partner can make them feel truly loved",
    "Specific, actionable tip 2",
    "Specific, actionable tip 3"
  ],
  "giving_tips": [
    "How they likely already express love — and one way to express it even more meaningfully",
    "Tip 2",
    "Tip 3"
  ],
  "growth_insight": "1–2 encouraging sentences: a growth opportunity or self-awareness insight based on their specific score pattern."
}

Make it feel like it was written just for them. Avoid clichés.`,
      }],
    });

    const message = await stream.finalMessage();
    const raw = message.content.find(b => b.type === 'text').text.trim();

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const analysis = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

    res.json({ analysis, languages, total });
  } catch (err) {
    console.error('Results error:', err.message);
    res.status(500).json({ error: 'Failed to generate your results. Please try again.' });
  }
});

// --------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✨ QuizVibe running → http://localhost:${PORT}`);
});
