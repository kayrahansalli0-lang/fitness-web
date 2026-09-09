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

// 1. ENDPOINT: Kalori Tarayıcı
app.post('/api/analyze-food', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Görsel verisi gönderilmedi.' });

    const apiKey = process.env.GEMINI_API_KEY;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

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
    res.status(500).json({ error: err.message });
  }
});

// 2. ENDPOINT: AI Mood Playlist (GÜNCELLENEN KISIM)
app.post('/api/generate-playlist', async (req, res) => {
  try {
    const { mood } = req.body;
    if (!mood) return res.status(400).json({ error: 'Mod/ortam açıklaması boş olamaz.' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Sunucuda API Key bulunamadı.' });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

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

    // YouTube araması hata verse bile şarkıların gelmesini engellemez
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

// 3. ENDPOINT: Yürüyüş Analizi
app.post('/api/analyze-walk', async (req, res) => {
  try {
    const { hedefAdi, secilenMesafeKm, kilo, tempo } = req.body;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Sunucuda API Key bulunamadı.' });

    const prompt = `Kullanıcı mevcut konumundan "${hedefAdi || 'seçilen hedefe'}" yürüyecek:
- Haritadaki Düz Kuş Uçuşu Mesafe: ${secilenMesafeKm} km (Şehir içi sokak kıvrımlarından ötürü gerçek yürüyüş genelde bunun %20-25 fazlasıdır, hesaba kat).
- Sporcu Ağırlığı: ${kilo} kg
- Hedeflenen Tempo: ${tempo}

Lütfen net ve samimi bir koç gibi yanıt ver:
1. Gerçek sokak şartlarına göre tahmini yürüme mesafesi ve kaç dakika süreceği.
2. Yakılacak ortalama kalori aralığı (kcal).
3. Bu enerjinin karşılığı olan somut bir Türk mutfağı/atıştırmalık besin örneği (örn: 1 simit, yarım porsiyon döner vb.).
4. Yürüyüş için 2 cümlelik pratik motivasyon ve hidrasyon/toparlanma önerisi.`;

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error?.message || `Gemini Hatası: ${response.status}`);
    }

    const data = await response.json();
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Analiz üretilemedi.";

    res.json({ text: resultText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend sunucusu http://localhost:${PORT} üzerinde çalışıyor.`);
});
