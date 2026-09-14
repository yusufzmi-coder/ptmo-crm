# Langkah apply — 045, 046, 047

Urutan wajib. 047 mesti **selepas** deploy kod.

```
1. Preflight akaun     baca seksyen 1, 2, 9, 10
2. Preflight storage    baca seksyen 1 dan 4 (kedua-duanya BLOCKER)
3. Apply 045
4. Apply 046
5. (kod sudah di-deploy — crm.ptmostaff.com hidup dengan main)
6. Apply 047
```

## Kenapa 047 terakhir

047 menjadikan tiga bucket storan **peribadi**. Saat ia mendarat, setiap
URL lampiran tersimpan berhenti berfungsi — ia URL bucket awam mutlak.

Yang menampungnya ialah `resolveStoredMediaUrl()` dalam kod, yang
memetakan URL lama ke proksi media pada masa render. Kod itu **sudah
hidup** pada domain. Jadi 047 selamat sekarang, dan hanya sekarang.

Backfill SQL yang akan menulis semula URL itu **ditarik balik** daripada
release: pangkalan data tidak boleh membezakan hos storan kita daripada
mana-mana `*.supabase.co`, jadi baris yang memegang URL projek lain akan
ditulis semula menunjuk ke bucket KITA. Laluan TypeScript menyemak hos
terhadap `NEXT_PUBLIC_SUPABASE_URL` dahulu.

Akibatnya sengaja: selepas release, nilai tersimpan kekal URL mati dan
**aplikasi yang menjadikannya berfungsi**. Apa-apa yang membaca
`messages.media_url` tanpa melalui `resolveStoredMediaUrl()` akan
melihat pautan yang 400.
