const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const cors = require('cors');
const yts = require('yt-search');

dotenv.config({ path: path.join(__dirname, '.env') });

const API_KEY = process.env.GEMINI_API_KEY;
console.log("Kontrol - Okunan Key:", API_KEY ? "ANAHTAR BULUNDU (GÜVENLİ)" : "HÂLÂ BOŞ GÖRÜNÜYOR!");

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname)));

// --- AKILLI ÖNBELLEK (CACHE) ---
const videoCache = new Map();

async function getYouTubeVideoId(query) {
  const cacheKey = query.toLowerCase().trim();

  if (videoCache.has(cacheKey)) {
    return videoCache.get(cacheKey);
  }

  try {
    const searchResult = await yts(query);
    const video = searchResult.videos && searchResult.videos[0];
    const videoId = video ? video.videoId : null;

    if (videoId) {
      if (videoCache.size > 3000) videoCache.clear();
      videoCache.set(cacheKey, videoId);
    }

    return videoId;
  } catch (err) {
    console.error(`YouTube arama hatası (${query}):`, err.message);
    return null;
  }
}

// 1. ENDPOINT: Kalori Tarayıcı (kalori.html için)
app.post('/api/analyze-food', async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Görsel verisi gönderilmedi.' });

    const key = API_KEY || process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: 'Sunucuda API Key bulunamadı.' });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${key}`;

    const payload = {
      contents: [{
        parts: [
          { text: "Bu fotoğraftaki yiyeceği/içeceği analiz et. Kesinlikle sadece geçerli bir JSON çıktısı ver. JSON formatı: {\"foodName\": \"...\", \"calories\": 0, \"protein\": \"...\", \"carbs\": \"...\", \"fat\": \"...\", \"notes\": \"...\"}" },
          { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }
        ]
      }],
      generationConfig: { responseMimeType: "application/json" }
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const resText = await response.text();
    if (!response.ok) {
      console.error("Gemini Food Error:", resText);
      return res.status(response.status).json({ error: `Gemini Hatası: ${resText}` });
    }

    const resJson = JSON.parse(resText);
    let text = resJson.candidates[0].content.parts[0].text;
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    res.json(JSON.parse(text));
  } catch (err) {
    console.error("Kalori Analiz Hatası:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. ENDPOINT: AI Mood Playlist (music.html için)
app.post('/api/generate-playlist', async (req, res) => {
  try {
    const { mood } = req.body;
    if (!mood) return res.status(400).json({ error: 'Mod açıklaması boş olamaz.' });

    const key = API_KEY || process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: 'Sunucuda API Key bulunamadı.' });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${key}`;

    const promptText = `Sen uzman bir müzik küratörüsün. Kullanıcının verdiği şu moda/aktiviteye göre tam 8 şarkılık bir liste hazırla: "${mood}".
Yanıtını SADECE geçerli bir JSON formatında ver. Açıklama metni veya markdown kodu yazma.
Format:
[
  {"artist": "Sanatçı Adı", "title": "Şarkı Adı", "vibe": "Kısa açıklama"}
]`;

    const payload = {
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.7
      }
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const resText = await response.text();
    if (!response.ok) {
      console.error("Gemini Playlist Error:", resText);
      return res.status(response.status).json({ error: `Gemini Hatası: ${resText}` });
    }

    const resJson = JSON.parse(resText);
    let rawText = resJson.candidates[0].content.parts[0].text;
    rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
    const songs = JSON.parse(rawText);

    const songsWithVideos = await Promise.all(
      songs.map(async (song) => {
        try {
          const videoId = await getYouTubeVideoId(`${song.artist} ${song.title} audio`);
          return { ...song, videoId: videoId };
        } catch (ytErr) {
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

    const key = API_KEY || process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: 'Sunucuda API Key bulunamadı.' });

    const isBudget = budgetType === 'student';
    const foodFocus = isBudget
      ? "Öğrenci/Bütçe dostu besinler (lor peyniri, haşlanmış yumurta, yeşil mercimek, yer fıstığı, tavuk ciğeri/göğsü, bulgur, yulaf)."
      : "Standart sporcu besinleri (dana eti, somon, tavuk/hindi göğsü, basmati pirinç, yumurta, kuruyemiş).";

    const prompt = `Sen profesyonel bir sporcu diyetisyenisin. 
Kullanıcı için şu makrolara BİREBİR UYGUN günlük tam 4 öğünlük beslenme planı hazırla:
- Günlük Hedef Kalori: ${targetCalories} kcal
- Protein: ${protein}g | Karbonhidrat: ${carbs}g | Yağ: ${fat}g
- Hedef Dönemi: ${goal || 'Definasyon / Kas Gelişimi'}
- Besin Stratejisi: ${foodFocus}

Kesinlikle sadece geçerli bir JSON formatında yanıt ver. Markdown veya ek metin yazma.
Format:
{
  "coachTip": "1-2 cümlelik tavsiye",
  "meals": [
    {
      "mealName": "1. Öğün (Kahvaltı)",
      "items": "Örn: 4 yumurta, 100g lor peyniri, 60g yulaf",
      "macros": "42g P, 50g K, 18g Y"
    }
  ]
}`;

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${key}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });

    const resText = await response.text();
    if (!response.ok) {
      console.error("Gemini Diet Error:", resText);
      return res.status(response.status).json({ error: `Gemini Hatası: ${resText}` });
    }

    const data = JSON.parse(resText);
    let text = data.candidates[0].content.parts[0].text;
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    res.json(JSON.parse(text));
  } catch (err) {
    console.error("Diyet/Makro Asistan Hatası:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. ENDPOINT: Dolap Şefi (chef.html için)
app.post('/api/fridge-chef', async (req, res) => {
  try {
    const { ingredientsText, imageBase64, targetProtein } = req.body;

    if (!ingredientsText && !imageBase64) {
      return res.status(400).json({ error: 'Lütfen malzeme yazın veya fotoğraf yükleyin.' });
    }

    const key = API_KEY || process.env.GEMINI_API_KEY;
    if (!key) return res.status(500).json({ error: 'Sunucuda API Key bulunamadı.' });

    const parts = [];

    if (imageBase64) {
      parts.push({
        inline_data: {
          mime_type: "image/jpeg",
          data: imageBase64
        }
      });
      parts.push({ text: "Fotoğraftaki malzemeleri belirle ve tarife dahil et." });
    }

    let promptContext = "Sen pratik bir fitness şefisin. ";
    if (ingredientsText) {
      promptContext += `Kullanıcının malzemeleri: ${ingredientsText}. `;
    }
    if (targetProtein) {
      promptContext += `Hedef protein: yaklaşık ${targetProtein}g. `;
    }

    promptContext += `Eldeki malzemelerle maksimum 15 dakikada hazırlanabilecek yüksek proteinli bir sporcu tarifi ver.
Yanıtı SADECE aşağıdaki JSON şemasına uygun ver:
{
  "recipeName": "Örnek Tarif Başlığı",
  "prepTime": "12 dk",
  "macros": {
    "calories": 420,
    "protein": 34,
    "carbs": 20,
    "fat": 10
  },
  "usedIngredients": ["3 yumurta", "100g lor peyniri"],
  "instructions": [
    "Yumurtaları ve loru çırpın.",
    "Tavada orta ateşte 4 dakika pişirin."
  ],
  "chefTip": "Tavsiye cümlesi"
}`;

    parts.push({ text: promptContext });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${key}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.4
        }
      })
    });

    const resText = await response.text();
    console.log("Chef Yanıt Kodu:", response.status);

    if (!response.ok) {
      console.error("Gemini Chef API Hatası:", resText);
      return res.status(response.status).json({ error: `Gemini Hatası (${response.status}): ${resText}` });
    }

    const resJson = JSON.parse(resText);
    let rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      console.error("Gemini Boş Cevap Döndü:", resJson);
      return res.status(500).json({ error: "Yapay zeka geçerli bir tarif içeriği döndürmedi." });
    }

    rawText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
    const recipeData = JSON.parse(rawText);

    // YouTube Video Araması (Varsa ekle, arama patlarsa tarifi bozma)
    try {
      const videoId = await getYouTubeVideoId(`${recipeData.recipeName} fit tarif`);
      recipeData.videoId = videoId;
    } catch (ytErr) {
      console.error("Tarif video arama hatası:", ytErr.message);
      recipeData.videoId = null;
    }

    return res.status(200).json(recipeData);

  } catch (err) {
    console.error("Dolap Şefi Kritik Sunucu Hatası:", err);
    return res.status(500).json({ error: 'Tarif sunucuda işlenirken hata oluştu: ' + err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend sunucusu http://localhost:${PORT} üzerinde çalışıyor.`);
});
