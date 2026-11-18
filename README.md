# Tidycast

Editor audio semplice per podcast (Windows e macOS). In precedenza si chiamava "Podcast Editor": i progetti `.podcast` già salvati si aprono ancora, e se esiste la vecchia cartella dati dell'app (`Podcast Editor` in AppData) viene riutilizzata, così non si perdono il salvataggio automatico e il modello vocale già scaricato. Electron + React + TypeScript, Web Audio per il motore, ffmpeg incluso (`ffmpeg-static`) per import/export.

## Comandi

```bash
npm install
npm run dev      # sviluppo (Vite + Electron)
npm start        # build e avvio
npm run dist     # installer (nsis su Windows, dmg su macOS)
```

L'installer per macOS va costruito su un Mac (ffmpeg-static scarica il binario della piattaforma corrente). Gli installer escono nella cartella `release/`.

Il riconoscimento vocale usa `onnxruntime-node`, che per macOS include solo i binari **Apple Silicon** (arm64): sui Mac con processore Intel il montaggio dal testo non è disponibile (il resto dell'app funziona).

## Uso rapido

- **Importa**: pulsante o trascina file (MP3, WAV, M4A, FLAC, OGG, anche audio da video).
- **Dividi** (`S`): taglia nella posizione del cursore. **Elimina** (`Canc`): rimuove il pezzo selezionato o l'intervallo scelto trascinando sul righello.
- **Sposta**: trascina un pezzo (anche tra tracce, con calamita sui bordi). Trascina i bordi per accorciare.
- **Fade**: slider nel pannello in basso o maniglie bianche sul pezzo selezionato.
- **Progetto**: Nuovo (`Ctrl+N`, con **modelli di partenza**: “Solo voce con intro e outro”, “Intervista a due”, “Voce con musica di sottofondo”, con tracce già nominate e impostate), Apri (`Ctrl+O`, o trascina un file `.podcast`), Salva (`Ctrl+S`, `Ctrl+Maiusc+S` per "Salva con nome"). Il progetto è un piccolo file che *punta* ai file audio originali: non spostarli o cancellarli. Se all'apertura ne manca qualcuno, l'app lo segnala.
- **Registra**: scegli microfono e uscita audio (con indicatore di livello), premi il pulsante rosso. La registrazione è scritta su disco mentre parli (`Documenti/Tidycast/Registrazioni`, WAV) e inserita nel punto del cursore sulla prima traccia libera. Importa è `Ctrl+I`.
- **✨ Migliora voce** (pannello in basso): riduce fruscio e rumori di fondo, toglie i rimbombi bassi e rende il volume della voce più uniforme. Lavora su una *copia* (`Documenti/Tidycast/Elaborati`): l'originale non viene toccato e si può tornare indietro in ogni momento. Senza selezione agisce su tutte le tracce che non sono musica.
- **🔇 Rimuovi silenzi**: accorcia le pause lunghe (intensità Leggera/Normale/Forte), con anteprima di quanti secondi verranno tolti. La soglia si adatta da sola al rumore di fondo della registrazione.
- **♫ Abbassa con la voce** (su ogni traccia): per la musica. Quando si parla sulle altre tracce la musica scende di circa 14 dB e risale nelle pause. La forma d'onda mostra l'abbassamento.
- **Esportazione**: titolo, podcast, autore, numero episodio, descrizione e copertina (JPG/PNG) vengono scritti nel file (copertina per MP3, M4A, FLAC). I dati del progetto restano salvati nel `.podcast`.
- **Salvataggio automatico**: ogni pochi secondi, se ci sono modifiche, viene creata una copia di sicurezza. Se l'app si chiude all'improvviso, alla riapertura propone di ripristinarla.
- **📝 Montaggio dal testo**: l'app trascrive la voce (modello Whisper, in locale: l'audio non lascia il computer). Per tagliare si selezionano le parole nel testo (clic, `Maiusc`+clic, `Ctrl`+clic) e si preme `Canc`; "Evidenzia gli ehm" li seleziona tutti. La prima volta va scaricato il modello (circa 80 MB, una volta sola, poi funziona offline). Il testo è salvato nel progetto. Il taglio vale per le tracce voce (la musica non si sposta).
- **〰 Dissolvenza incrociata**: dopo un taglio elimina il "clic". Con un pezzo selezionato ("Sfuma col precedente", 0,3 s) o su tutti i tagli ("Sfuma i tagli", 0,15 s). Usa l'audio di scorta oltre i bordi del taglio.
- **🔖 Capitoli** (`M` aggiunge un capitolo al cursore, "Capitoli" per rinominarli): bandierine sul righello, seguono i tagli e vengono scritti nel file esportato (MP3 e M4A).
- **Registra ascoltando il progetto**: nella finestra Registra, "Ascolta il progetto mentre registri" (usa le cuffie). La registrazione parte dal cursore e viene compensato il ritardo di cuffie e microfono.
- **Esporta** (`Ctrl+E`): preset **Podcast** (MP3, volume uniforme), **Qualità massima** (FLAC) o personalizzato, con anteprima di durata, dimensione stimata e cosa verrà incluso (copertina, capitoli). Formati: MP3, M4A, WAV, FLAC, OGG; "volume uniforme per podcast" = -16 LUFS.
- `Spazio` play/pausa, `Ctrl+Z` / `Ctrl+Y` annulla/ripristina, `+` / `-` zoom.
