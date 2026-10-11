# WhatsApp message template

Create in **WhatsApp Manager → Message templates → Create template**

- Category: **Utility** (Custom)
- Name: `daily_job_report`
- Language: **Arabic (ar)**
- Body:

```
صباح الخير، ده تقرير الوظائف اليومي بتاريخ {{1}}.
🆕 الوظائف الجديدة المناسبة: {{2}}
✅ الطلبات اللي اتقدمت واتأكدت: {{3}}
✋ وظائف محتاجة تقديم يدوي: {{4}}
📊 المهارات الأكثر طلبًا: {{5}}
💰 متوسط الرواتب: {{6}}
📰 أهم الأخبار: {{7}}
التفاصيل الكاملة بتوصلك في رسالة بعد التقرير.
```

The workflow trims every variable so the rendered message stays under WhatsApp's 1024-character limit.

## Permanent access token
1. Business settings → **System users** → add a user (Employee role is enough).
2. Business settings → **Accounts → WhatsApp accounts** → select your account → assign that system user with **Full control**.
3. System users → **Generate token** → expiration **Never** → scopes `whatsapp_business_messaging`, `whatsapp_business_management`.
4. Check it in the [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken): *Granular Scopes* must list your WhatsApp Business Account ID, not "Applies to all objects".
