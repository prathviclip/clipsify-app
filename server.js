const express = require('express');
const axios = require('axios');
const cors = require('cors');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: true, credentials: true }));

app.use(session({
  name: '__Host-clipsify-sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false, // Set to true in production with HTTPS
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24
  }
}));

// Rate Limiter against Bot Spam
const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many submission attempts. Please try again in an hour.' }
});

// Database Store
const db = {
  campaigns: [
    {
      id: "camp_01",
      title: "Summer Gaming Highlights",
      payout: "$50 per 10k views",
      requiredHashtag: "#ClipsifyGaming",
      requiredTag: "@clipsify_app",
      status: "active"
    },
    {
      id: "camp_02",
      title: "Viral Meme Promo",
      payout: "$30 flat per clip",
      requiredHashtag: "#ClipsifyViral",
      requiredTag: "@clipsify_official",
      status: "active"
    }
  ],
  users: {},
  submissions: [],
  submittedVideoIds: new Set() // Prevents duplicate payout exploits
};

// Helper: Extract Platform Video ID
function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtu.be')) {
      const match = url.match(/(?:shorts\/|v=)([\w-]+)/);
      return match ? `yt_${match[1]}` : null;
    }
    if (parsed.hostname.includes('tiktok.com')) {
      const match = url.match(/video\/(\d+)/);
      return match ? `tt_${match[1]}` : null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Helper: Fetch Metadata via Official OEmbed Providers
async function fetchVerifiedMetadata(videoUrl) {
  let endpoint = '';
  if (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be')) {
    endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
  } else if (videoUrl.includes('tiktok.com')) {
    endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`;
  } else {
    throw new Error('Unsupported platform. Submit a YouTube Short or TikTok video.');
  }

  const response = await axios.get(endpoint, { timeout: 5000 });
  return {
    title: response.data.title || '',
    authorName: response.data.author_name || ''
  };
}

// Serve Frontend
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.get('/api/campaigns', (req, res) => {
  res.json({ success: true, campaigns: db.campaigns.filter(c => c.status === 'active') });
});

app.post('/api/generate-code', (req, res) => {
  const userId = req.session.userId || "demo_clipper_1";
  if (!db.users[userId]) db.users[userId] = { verified: false };

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  db.users[userId].code = code;

  res.json({ success: true, code });
});

app.post('/api/submit-clip', submissionLimiter, async (req, res) => {
  const userId = req.session.userId || "demo_clipper_1";
  const { campaignId, videoUrl } = req.body;

  if (!videoUrl || typeof videoUrl !== 'string') {
    return res.status(400).json({ error: 'Please enter a valid video URL.' });
  }

  const campaign = db.campaigns.find(c => c.id === campaignId && c.status === 'active');
  if (!campaign) {
    return res.status(404).json({ error: 'Selected campaign is inactive or not found.' });
  }

  const uniqueId = extractVideoId(videoUrl);
  if (!uniqueId) {
    return res.status(400).json({ error: 'Invalid URL. Supported formats: TikTok video or YouTube Short.' });
  }

  // Anti-Cheat: Block Duplicate Submissions
  if (db.submittedVideoIds.has(uniqueId)) {
    return res.status(409).json({ error: 'FRAUD PREVENTION: This clip has already been submitted!' });
  }

  try {
    const meta = await fetchVerifiedMetadata(videoUrl);
    const captionLower = meta.title.toLowerCase();

    const hasHashtag = captionLower.includes(campaign.requiredHashtag.toLowerCase());
    const hasTag = captionLower.includes(campaign.requiredTag.toLowerCase());

    if (!hasHashtag || !hasTag) {
      const missing = [];
      if (!hasHashtag) missing.push(campaign.requiredHashtag);
      if (!hasTag) missing.push(campaign.requiredTag);
      return res.status(400).json({ error: `Verification failed! Missing ${missing.join(' and ')} in official video caption.` });
    }

    db.submittedVideoIds.add(uniqueId);

    const submission = {
      id: 'sub_' + crypto.randomBytes(6).toString('hex'),
      userId,
      campaignTitle: campaign.title,
      videoUrl,
      authorName: meta.authorName,
      status: 'pending',
      submittedAt: new Date().toISOString()
    };

    db.submissions.push(submission);
    return res.json({ success: true, message: 'Clip verified via official servers! Submitted to admin queue.' });

  } catch (err) {
    return res.status(400).json({ error: 'Could not inspect video caption. Ensure the video is public.' });
  }
});

app.get('/api/admin/submissions', (req, res) => {
  res.json({ submissions: db.submissions });
});

app.post('/api/admin/update-status', (req, res) => {
  const { submissionId, status } = req.body;
  const sub = db.submissions.find(s => s.id === submissionId);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });

  sub.status = status;
  res.json({ success: true, message: `Submission marked as ${status}` });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

