# ТЗ: AI Shopping Optimizer для Сільпо через n8n + Telegram + MCP

## 1. Мета

Потрібно реалізувати demo AI-агента, який працює через Telegram-бота та n8n і допомагає користувачу **зменшити вартість уже готового кошика Сільпо, не змінюючи його суті**.

Основний сценарій:

1. Користувач відкриває Telegram-бота.
2. Авторизується у своєму акаунті Сільпо через офіційний MCP.
3. Агент отримує активний кошик.
4. Аналізує кожну позицію.
5. Для кожного товару шукає:
   - схожі товари;
   - можливі заміни;
   - товари з акціями;
   - персональні пропозиції;
   - купони;
   - промокоди;
   - можливість використання балабонусів.
6. Порівнює ціни.
7. Формує оптимальні варіанти заміни.
8. Показує користувачу:
   - поточний товар;
   - альтернативний товар;
   - різницю в ціні;
   - сумарну економію;
   - які акції/купони/бонуси використані.
9. Користувач може погодитися на запропоновані зміни.
10. Тільки після підтвердження агента дозволено змінювати реальний кошик.
11. Після змін агент повторно отримує кошик і показує фактичний результат.

Головна demo-метрика:

> **«Було: 1 847 грн → Стало: 1 630 грн → Економія: 217 грн»**

---

# 2. Ключовий принцип

Агент НЕ повинен просто шукати найдешевші товари.

Він повинен зберігати **сутність покупки**.

Наприклад:

- молоко 2.5% → інше молоко 2.5%, а не рослинний напій;
- Coca-Cola 1.75 л → аналогічний газований напій такого ж призначення;
- макарони → макарони;
- куряче філе → куряче філе;
- пральний порошок → пральний порошок.

Потрібно враховувати:

- категорію;
- назву;
- об'єм;
- вагу;
- кількість;
- бренд;
- характеристики;
- ціну;
- ціну за одиницю/кг/літр;
- доступність;
- акції;
- персональні пропозиції.

AI може запропонувати альтернативу, але не повинен без причини змінювати тип товару.

---

# 3. Архітектура

Побудувати систему приблизно так:

Telegram User
↓
Telegram Bot
↓
n8n Webhook / Telegram Trigger
↓
AI Agent / Orchestrator
↓
Silpo MCP
↓
Silpo account / cart / promotions / loyalty
↓
Optimization Engine
↓
Telegram response
↓
User confirmation
↓
n8n
↓
Silpo MCP write tools
↓
Updated cart
↓
Final result

Основна бізнес-логіка повинна знаходитися в n8n.

AI використовувати для:

- розуміння запиту;
- класифікації товарів;
- оцінки схожості;
- ранжування альтернатив;
- формування пояснення користувачу.

Детерміновану математику економії робити через JavaScript Code nodes у n8n, а не довіряти LLM.

---

# 4. Обов'язково використати офіційний MCP Сільпо

MCP URL:

https://mcp.silpo.ua/mcp

Не використовувати сторонні API або scraping.

MCP використовує OAuth 2.1 + PKCE.

Документація також вказує, що токен потрібно зберігати серверно, а не у frontend.

Усі точні назви tools та JSON Schema потрібно отримувати через MCP `tools/list`, а не хардкодити наосліп.

Особливо перевірити такі tools:

- silpo_get_my_shopping_cart
- silpo_get_shopping_cart_by_id
- silpo_get_time_slots
- silpo_get_similar_products
- silpo_get_replacements
- silpo_get_promotions
- silpo_get_my_coupons
- silpo_get_promo_codes
- silpo_get_my_promos
- silpo_get_loyalty_info
- silpo_update_shopping_cart

Згідно з документацією, `silpo_get_my_shopping_cart` повинен бути стартовим кроком для роботи з активним кошиком, після чого потрібно отримати повний кошик через `silpo_get_shopping_cart_by_id`.

---

# 5. ВАЖЛИВО: працюй зі мною поетапно

Не намагайся одразу створити весь проєкт.

Працюй у таких фазах:

## PHASE 0 — Аналіз

Спочатку:

1. Проаналізуй файл `msp.md`.
2. Витягни з нього всі доступні MCP tools.
3. Визнач, які tools потрібні саме для Shopping Optimizer.
4. Побудуй architecture diagram у текстовому вигляді.
5. Визнач, де потрібен Telegram.
6. Визнач, де потрібен n8n.
7. Визнач, де потрібен AI model.
8. Визнач, як буде проходити OAuth.
9. Визнач, де і як зберігатиметься зв'язок Telegram user → Silpo authorization.
10. Визнач ризики та обмеження.

Після цього НЕ переходь автоматично далі.

Покажи мені:

### Що мені потрібно зробити вручну

Наприклад:

- створити Telegram Bot через BotFather;
- отримати Telegram Bot Token;
- створити/налаштувати n8n;
- налаштувати MCP;
- авторизуватися в Сільпо;
- створити OAuth credentials;
- додати OpenAI/Anthropic API key;
- додати environment variables;
- тощо.

Для кожного пункту напиши:

**1. Що зробити  
2. Де це зробити  
3. Що саме натиснути  
4. Яке значення отримати  
5. Куди вставити це значення в n8n**

Не переходь до наступної фази, доки я не підтверджу готовність.

---

# PHASE 1 — Telegram

Після мого підтвердження:

Створити Telegram integration.

Пояснити мені:

1. Як створити бота через @BotFather.
2. Який token отримати.
3. Де вставити token у n8n.
4. Який Telegram Trigger використати.
5. Який формат повідомлень використовувати.
6. Як зробити inline buttons.

Потрібні приблизно такі кнопки:

- 🔍 Оптимізувати кошик
- 💰 Показати економію
- ✅ Застосувати зміни
- ❌ Скасувати

---

# PHASE 2 — Silpo MCP

Підключити офіційний MCP:

https://mcp.silpo.ua/mcp

Не припускати структуру API.

Спочатку отримати `tools/list`.

Перевірити реальні:

- tool names;
- input schemas;
- output schemas;
- required parameters.

Після цього створити mapping:

| Бізнес-задача | MCP tool |
|---|---|
| Отримати активний кошик | ... |
| Отримати повний кошик | ... |
| Отримати схожі товари | ... |
| Отримати заміни | ... |
| Отримати акції | ... |
| Отримати купони | ... |
| Отримати промокоди | ... |
| Отримати персональні промо | ... |
| Отримати балабонуси | ... |
| Оновити кошик | ... |

Якщо назва або schema відрізняється від документації — використовувати фактичну schema MCP.

---

# PHASE 3 — Авторизація

Розібрати OAuth 2.1 + PKCE.

Потрібно зробити так, щоб:

Telegram user A
→ використовує свій Silpo account

Telegram user B
→ використовує свій Silpo account

Не можна використовувати один глобальний Silpo token для всіх користувачів.

Потрібен mapping:

telegram_user_id
→ silpo authorization/session/token reference

Визначити найбезпечніший спосіб зберігання.

Якщо для OAuth потрібен окремий backend/service — чітко сказати мені це.

Якщо це можливо реалізувати тільки через n8n — зробити через n8n.

Не зберігати Silpo JWT у Telegram або frontend.

---

# PHASE 4 — Отримання кошика

Реалізувати:

1. `silpo_get_my_shopping_cart`
2. `silpo_get_shopping_cart_by_id`
3. `silpo_get_time_slots`

Документація MCP прямо рекомендує цей порядок.

З кошика отримати нормалізовану структуру:

```json
{
  "cartId": "...",
  "branchId": "...",
  "deliveryType": "...",
  "items": [
    {
      "productId": "...",
      "name": "...",
      "brand": "...",
      "quantity": 1,
      "unit": "...",
      "price": 0,
      "total": 0,
      "category": "...",
      "available": true
    }
  ],
  "subtotal": 0,
  "delivery": 0,
  "discount": 0,
  "total": 0,
  "loyalty": {
    "bonusAvailable": 0,
    "bonusRequested": 0
  }
}
```

Але якщо реальна schema MCP відрізняється — адаптувати під неї.

---

# PHASE 5 — Пошук альтернатив

Для кожної позиції кошика:

1. Викликати `silpo_get_similar_products`.
2. Якщо товар unavailable — перевірити `silpo_get_replacements`.
3. Отримати кандидатів.
4. Відфільтрувати очевидно непридатні товари.
5. Отримати актуальні ціни.
6. Перевірити акції.

Не робити сотні послідовних MCP calls, якщо можна виконати операції паралельно.

Використати n8n Split In Batches / Loop Over Items або інший оптимальний механізм.

Передбачити rate limits.

При HTTP 429 використовувати exponential backoff.

Документація MCP прямо вказує на per-user rate limiting та необхідність exponential backoff.

---

# PHASE 6 — Акції, купони та бонуси

Для користувача отримати:

- promotions;
- coupons;
- personal promos;
- promo codes;
- loyalty information.

Врахувати:

`loyalty.bonusAvailable`

Якщо бонуси доступні — показати користувачу окрему потенційну економію.

Наприклад:

```text
💰 Балабонуси

Доступно: 340 балабонусів

Можлива економія: 340 грн
```

Не рахувати бонуси як гарантовану економію, якщо фактичний checkout/cart response не підтверджує їх застосування.

---

# PHASE 7 — Optimization Engine

Створити deterministic JS Code node.

Для кожного товару:

```text
currentPrice
alternativePrice
discount
couponDiscount
promoDiscount
bonusImpact
```

Розрахувати:

```text
saving = currentEffectivePrice - alternativeEffectivePrice
```

Після цього:

```text
totalSaving = sum(all_positive_savings)
```

Не дозволяти AI вигадувати ціни.

Ціни та економія повинні походити виключно з MCP responses або детермінованих розрахунків.

---

# PHASE 8 — Ranking

Для кожної альтернативи розрахувати score.

Наприклад:

```text
similarityScore
priceSavingScore
brandMatchScore
sizeMatchScore
categoryMatchScore
promotionScore
availabilityScore
```

Фінальний score:

```text
finalScore =
  similarityScore * 0.40 +
  priceSavingScore * 0.25 +
  brandMatchScore * 0.10 +
  sizeMatchScore * 0.10 +
  promotionScore * 0.10 +
  availabilityScore * 0.05
```

Але якщо AI/Claude запропонує кращу формулу — спочатку поясни її та запропонуй.

Не змінюй формулу мовчки.

---

# PHASE 9 — AI Agent

AI Agent повинен отримувати вже структуровані дані.

AI не повинен сам вигадувати MCP parameters.

AI має відповісти структурованим JSON:

```json
{
  "recommendations": [
    {
      "originalProductId": "...",
      "originalName": "...",
      "replacementProductId": "...",
      "replacementName": "...",
      "reason": "...",
      "saving": 0,
      "confidence": 0
    }
  ],
  "summary": {
    "originalTotal": 0,
    "optimizedTotal": 0,
    "saving": 0
  }
}
```

AI має відхиляти альтернативи з низькою semantic similarity.

---

# PHASE 10 — Telegram UX

Приклад відповіді:

```text
🛒 Я проаналізував ваш кошик

Було: 1 847 грн
Може стати: 1 630 грн

💰 Економія: 217 грн

Я знайшов 3 вигідні заміни:

1. 🥛 Молоко X
   → Молоко Y
   Економія: 32 грн

2. 🍝 Макарони X
   → Макарони Y
   Економія: 45 грн

3. ☕ Кава X
   → Кава Y
   Економія: 140 грн

🎁 Додатково:
Балабонуси: -50 грн

Застосувати оптимізацію?
```

Кнопки:

`✅ Застосувати`

`🔍 Показати деталі`

`❌ Скасувати`

---

# PHASE 11 — Confirmation

КРИТИЧНО:

Агент НЕ повинен змінювати реальний кошик одразу після аналізу.

Спочатку:

```text
analysis
↓
recommendations
↓
user confirmation
↓
write operations
```

Тільки після натискання:

`✅ Застосувати`

дозволено викликати:

`silpo_add_or_update_cart_products`

або:

`silpo_remove_cart_products`

або:

`silpo_update_shopping_cart`

відповідно до реальної MCP schema.

---

# PHASE 12 — Verification

Після зміни кошика ОБОВ'ЯЗКОВО:

1. Повторно викликати `silpo_get_shopping_cart_by_id`.
2. Отримати фактичну суму.
3. Порівняти з початковою.
4. Порахувати фактичну економію.

Наприклад:

```text
Початкова сума: 1 847 грн
Фактична сума після оптимізації: 1 630 грн

💰 Фактично зекономлено: 217 грн
```

Саме ця цифра повинна використовуватись як головна demo metric.

---

# PHASE 13 — Error handling

Передбачити:

- OAuth expired;
- 401;
- 403;
- 429;
- MCP unavailable;
- product unavailable;
- replacement unavailable;
- promotion expired;
- coupon not applicable;
- cart changed by another session;
- price changed;
- insufficient bonuses;
- invalid cart;
- Telegram API error;
- AI API error.

Для кожної помилки користувач повинен отримати зрозуміле повідомлення.

Не показувати raw stack trace.

---

# PHASE 14 — n8n workflow

Створити workflow приблизно такого вигляду:

```text
Telegram Trigger
      ↓
Identify User
      ↓
Check Silpo Authorization
      ↓
Get Active Cart
      ↓
Get Full Cart
      ↓
Get Delivery Context
      ↓
Get Loyalty
      ↓
Get Promotions
      ↓
Get Coupons
      ↓
Get Promo Codes
      ↓
Split Cart Items
      ↓
Get Similar Products
      ↓
Get Replacements
      ↓
Normalize Candidates
      ↓
Calculate Prices
      ↓
Optimization Engine
      ↓
AI Ranking
      ↓
Build Recommendation
      ↓
Telegram
      ↓
Wait for User Confirmation
      ↓
IF confirmed
      ↓
Update Silpo Cart
      ↓
Get Updated Cart
      ↓
Calculate Actual Saving
      ↓
Telegram Result
```

---

# PHASE 15 — n8n implementation

Потрібно реалізувати workflow максимально практично.

Для кожного node напиши:

- Node name
- Node type
- Purpose
- Input
- Output
- Important configuration
- Expressions
- Credentials
- Dependencies

Якщо поле потребує ручного заповнення — чітко познач:

`USER ACTION REQUIRED`

Наприклад:

```text
USER ACTION REQUIRED

Create Telegram bot:

1. Open @BotFather
2. /newbot
3. Enter name
4. Enter username
5. Copy token

Paste token into:

n8n → Credentials → Telegram API
```

---

# PHASE 16 — Credentials

Створити окремий список:

## Required credentials

### Telegram

Потрібно:

```text
TELEGRAM_BOT_TOKEN
```

Як отримати — пояснити.

### AI

Визначити, який provider використовується.

Наприклад:

```text
OPENAI_API_KEY
```

або Anthropic.

Пояснити, що саме потрібно створити.

### Silpo MCP

Пояснити реальний OAuth flow.

Не вигадувати credentials, яких MCP не потребує.

---

# PHASE 17 — Environment variables

В кінці сформувати:

```env
TELEGRAM_BOT_TOKEN=
AI_API_KEY=
SILPO_MCP_URL=https://mcp.silpo.ua/mcp
```

Додавати тільки ті змінні, які реально потрібні.

---

# PHASE 18 — Security

Обов'язково:

- не hardcode secrets;
- не передавати Silpo tokens у Telegram;
- не логувати access tokens;
- не логувати authorization headers;
- не зберігати credentials у Code nodes;
- використовувати n8n Credentials;
- врахувати multi-user isolation.

Офіційна документація Сільпо також вимагає серверного зберігання токенів.

---

# PHASE 19 — Demo mode

Потрібно зробити demo максимально наочним.

При запуску:

```text
🛒 Оптимізуємо ваш кошик...
```

Потім:

```text
Знайдено 14 товарів

🔎 Перевіряю альтернативи...
🎁 Перевіряю акції...
🎟 Перевіряю купони...
💳 Перевіряю балабонуси...
```

Фінальний результат:

```text
🎉 Оптимізація готова

Було:
1 847 грн

Стало:
1 630 грн

💰 ЕКОНОМІЯ:
217 грн

14 товарів проаналізовано
3 заміни знайдено
2 акції використано
1 купон використано
```

Це повинно добре виглядати на demo/video.

---

# PHASE 20 — Final deliverables

В кінці потрібно надати мені ВСЕ необхідне для запуску.

## 1. Готовий n8n JSON

Один або кілька JSON workflow, які можна імпортувати в n8n:

```text
n8n → Import from File
```

JSON повинен бути валідним.

Не псевдо-JSON.

Не скорочувати:

```text
...
```

Не залишати критичні node configuration як TODO, якщо це можна реалізувати.

---

## 2. Setup guide

Окремо:

```text
STEP 1
Create Telegram Bot

STEP 2
Configure n8n

STEP 3
Configure AI credentials

STEP 4
Configure Silpo MCP

STEP 5
Authorize Silpo

STEP 6
Import workflow

STEP 7
Configure credentials

STEP 8
Run test
```

---

## 3. Manual actions

Окремий список:

```text
Я повинен зробити:

[ ] Create Telegram bot
[ ] Add Telegram credentials
[ ] Add AI credentials
[ ] Configure MCP
[ ] Login to Silpo
[ ] ...
```

---

## 4. Test scenario

Створити конкретний тест:

```text
1. Open Telegram
2. /start
3. Connect Silpo
4. Open existing cart
5. Click "Оптимізувати"
6. Wait
7. Review recommendations
8. Click "Застосувати"
9. Verify final price
```

---

## 5. Expected result

Наприклад:

```text
Input:
Cart = 1 847 грн

Output:
Optimized cart = 1 630 грн

Saving:
217 грн
```

---

# PHASE 21 — Debugging

Якщо щось не працює:

НЕ кажи просто:

> "Перевірте credentials."

Замість цього:

1. Визнач конкретний node.
2. Покажи expected input.
3. Покажи expected output.
4. Покажи фактичну помилку.
5. Поясни причину.
6. Дай конкретну інструкцію, що змінити.
7. Якщо можливо — сам виправ workflow JSON.

---

# PHASE 22 — Важливе правило

Не вигадуй API, tools, parameters або schemas.

Якщо документація `msp.md` каже одне, а фактичний `tools/list` MCP повертає інше — використовуй фактичний MCP schema.

Перед генерацією фінального JSON переконайся, що:

- node names правильні;
- MCP URL правильний;
- tool names правильні;
- parameters відповідають schema;
- JSON валідний;
- workflow можна імпортувати в n8n.

---

# PHASE 23 — Порядок роботи Claude

Працюй строго так:

```text
PHASE 0
↓
WAIT FOR USER

PHASE 1
↓
WAIT FOR USER

PHASE 2
↓
WAIT FOR USER

...

FINAL
↓
GENERATE N8N JSON
```

Не перескакуй через фази.

На кожній фазі спочатку пояснюй мені:

### Що робимо

### Навіщо

### Що потрібно від мене

### Де це зробити

### Що саме вставити

### Як перевірити

Після завершення фази чекай мого підтвердження.

---

# Критерій готовності

Проєкт вважається готовим тільки якщо:

1. Telegram bot працює.
2. Користувач може авторизувати свій Silpo account.
3. Агент отримує реальний кошик.
4. Агент аналізує товари.
5. Агент знаходить альтернативи.
6. Агент перевіряє акції.
7. Агент перевіряє купони.
8. Агент перевіряє промокоди.
9. Агент враховує балабонуси.
10. Агент показує delta в гривнях.
11. Користувач підтверджує зміни.
12. Кошик реально оновлюється.
13. Після оновлення агент повторно отримує кошик.
14. Показується фактична економія.
15. n8n workflow можна експортувати.
16. Claude надає готовий валідний JSON для імпорту в n8n.
17. Всі ручні дії користувача описані покроково.

# Починай з PHASE 0.

Спочатку проаналізуй `msp.md` і скажи, яка архітектура потрібна та що саме мені потрібно підготувати. Не створюй поки фінальний workflow.