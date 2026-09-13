const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const cors = require('cors');
const yts = require('yt-search');

dotenv.config({ path: path.join(__dirname, '.env') });

console.log("Kontrol - Okunan Key:", process.env.GEMINI_API_KEY ? "ANAHTAR BULUNDU (GÜVENLİ)" : "HÂLÂ BOŞ GÖRÜNÜYOR!");

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(cors());

// --- AKILLI ÖNBELLEK (CACHE) ---
const videoCache = new Map();

async function getYouTubeVideoId(title, artist) {
  const cacheKey = `${artist} - ${title}`.toLowerCase().trim();

  if (videoCache.has(cacheKey)) {
    return videoCache.get(cacheKey);
  }

  try {
    const query = `${artist} ${title} audio`;
    const searchResult = await yts(query);
    const video = searchResult.videos && searchResult.videos[0];
    const videoId = video ? video.videoId : null;

    if (videoId) {
      if (videoCache.size > 3000) videoCache.clear();
      videoCache.set(cacheKey, videoId);
    }

    return videoId;
  } catch (err) {
    console.error(`YouTube arama hatası (${artist} - ${title}):`, err.message);
    return null;
  }
}

// 1. ENDPOINT: Kalori Tarayıcı (kalori.html için)
app.post('/api/analyze-food', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Görsel verisi gönderilmedi.' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Sunucuda API Key bulunamadı.' });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const payload = {
      contents: [{
        parts: [
          { text: "Bu fotoğraftaki yiyeceği/içeceği analiz et. Kesinlikle sadece geçerli bir JSON çıktısı ver. JSON formatı: {\"foodName\": \"...\", \"calories\": 0, \"protein\": \"...\", \"carbs\": \"...\", \"fat\": \"...\", \"notes\": \"...\"}" },
          { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }
        ]
      }],
      generationConfig: { response_mime_type: "application/json" }
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error?.message || `Gemini Hatası: ${response.status}`);
    }

    const resJson = await response.json();
    const data = JSON.parse(resJson.candidates[0].content.parts[0].text);
    res.json(data);
  } catch (err) {
    console.error("Kalori Analiz Hatası:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. ENDPOINT: AI Mood Playlist (music.html için)
app.post('/api/generate-playlist', async (req, res) => {
  try {
    const { mood } = req.body;
    if (!mood) return res.status(400).json({ error: 'Mod/ortam açıklaması boş olamaz.' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Sunucuda API Key bulunamadı.' });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const promptText = `Sen uzman bir müzik küratörüsün. Kullanıcının verdiği şu moda/aktiviteye göre tam 8 şarkılık bir liste hazırla: "${mood}".
Yanıtını SADECE geçerli bir JSON formatında ver. Açıklama metni veya markdown kodu yazma.
Format:
[
  {"artist": "Sanatçı Adı", "title": "Şarkı Adı", "vibe": "Kısa açıklama"}
]`;

    const payload = {
      contents: [{
        parts: [{ text: promptText }]
      }],
      generationConfig: {
        response_mime_type: "application/json",
        temperature: 0.7
      }
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errData = await response.json();
      console.error("Gemini Yanıt Hatası:", errData);
      throw new Error(errData.error?.message || `Gemini API Hatası: ${response.status}`);
    }

    const resJson = await response.json();
    const rawText = resJson.candidates[0].content.parts[0].text;
    const cleanJson = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
    const songs = JSON.parse(cleanJson);

    const songsWithVideos = await Promise.all(
      songs.map(async (song) => {
        try {
          const videoId = await getYouTubeVideoId(song.title, song.artist);
          return { ...song, videoId: videoId };
        } catch (ytErr) {
          console.error("YouTube arama tekil hata:", ytErr.message);
          return { ...song, videoId: null };
        }
      })
    );

    res.json(songsWithVideos);
  } catch (err) {
    console.error("KRİTİK PLAYLIST HATASI:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. ENDPOINT: Akıllı Makro & Beslenme Asistanı (makro.html için)
app.post('/api/generate-diet', async (req, res) => {
  try {
    const { targetCalories, protein, carbs, fat, goal, budgetType } = req.body;

    if (!targetCalories || !protein) {
      return res.status(400).json({ error: 'Hedef kalori ve protein değerleri eksik.' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Sunucuda API Key bulunamadı.' });

    const isBudget = budgetType === 'student';
    const foodFocus = isBudget
      ? "Öğrenci/Bütçe dostu, markette en ucuz protein/kalori sağlayan besinler (lor peyniri, haşlanmış yumurta, yeşil mercimek, yer fıstığı, tavuk ciğeri/tavuk göğsü, bulgur, yulaf)."
      : "Standart sporcu besinleri (dana eti, somon/balık, tavuk/hindi göğsü, basmati pirinç, yumurta, badem/ceviz).";

    const prompt = `Sen profesyonel bir sporcu diyetisyenisin. 
Kullanıcı için şu makrolara BİREBİR UYGUN günlük tam 4 öğünlük beslenme planı hazırla:
- Günlük Hedef Kalori: ${targetCalories} kcal
- Protein: ${protein}g | Karbonhidrat: ${carbs}g | Yağ: ${fat}g
- Hedef Dönemi: ${goal || 'Definasyon / Kas Gelişimi'}
- Besin Stratejisi: ${foodFocus}

Kesinlikle sadece geçerli bir JSON formatında yanıt ver. Markdown veya ek metin yazma.
Format şu şemada olmalıdır:
{
  "coachTip": "Sporcuya bu hedefe ulaşması için 1-2 cümlelik pratik koç tavsiyesi",
  "meals": [
    {
      "mealName": "1. Öğün (Kahvaltı)",
      "items": "Örn: 4 yumurta (2 sarısı ile), 100g lor peyniri, 60g yulaf",
      "macros": "Yaklaşık makro (örn: 42g P, 50g K, 18g Y)"
    }
  ]
}`;

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: "application/json" }
      })
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error?.message || `Gemini Hatası: ${response.status}`);
    }

    const data = await response.json();
    const resultJson = JSON.parse(data.candidates[0].content.parts[0].text);

    res.json(resultJson);
  } catch (err) {
    console.error("Diyet/Makro Asistan Hatası:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend sunucusu http://localhost:${PORT} üzerinde çalışıyor.`);
});