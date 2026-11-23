# Prywatny czat AI na Proxmox VE

Noxin udostępnia czat, odczyt stron PDF i DOCX oraz OCR po polsku i angielsku. Caddy przekazuje zapytania Noxin do Agenta AI, domyślnie pod `http://127.0.0.1:8090` w tym samym LXC. Llama Chat jest dostępny na osobnym porcie HTTPS. Oba interfejsy domyślnie używają jednego modelu na CPU i jednego slotu generowania. Model i konwertery działają przez gniazda Unix z ograniczeniem do `AF_UNIX`. Caddy udostępnia oba interfejsy przez HTTPS w wybranej podsieci LAN.

Noxin nie zapisuje rozmów ani wyciągów dokumentów. Są dostępne w pamięci otwartego modułu. Pliki przesłane do OCR są przetwarzane w prywatnym katalogu tymczasowym i usuwane po zakończeniu przetwarzania. Llama Chat może zachowywać historię w pamięci przeglądarki. Na współdzielonym urządzeniu używaj trybu prywatnego lub wyczyść dane witryny dla portu 8443.

## 1. Audyt hosta

Skopiuj `audit-proxmox.sh` na host lub użyj odczytu z własnego checkoutu. Wykonaj w powłoce Proxmox jako administrator.

```bash
bash audit-proxmox.sh
```

Sprawdź model i instrukcje CPU, wolną pamięć, składowisko z typem `rootdir`, obciążenie gości i most `vmbr0`. Przy domyślnej konfiguracji skrypt tworzenia wymaga co najmniej 5888 MiB dostępnej pamięci i 22 GiB wolnych na składowisku. Limit 5 GiB jest górnym limitem użycia LXC. Przy większym obciążeniu hosta rozważ limit 4096 MiB i sprawdź zużycie ponownie podczas OCR. Docelową konfigurację można zatwierdzić po odczycie wyniku audytu.

## 2. Pakiet z frontem

W katalogu głównym repozytorium, na komputerze z Node.js, zbuduj frontend i skopiuj pakiet na host. Zastąp przykładowy adres adresem Proxmoxa. Przed kopiowaniem możesz obejrzeć listę plików przez `tar -tf $NoxinBundle`.

```powershell
$PveSsh = 'root@192.168.1.10'
$NoxinBundle = Join-Path $env:TEMP 'noxin-ai.tar'
npm.cmd --prefix noxin-front ci
npm.cmd --prefix noxin-front run build -- --configLoader runner
tar -cf $NoxinBundle --exclude=__pycache__ deploy/ai noxin-front/dist
scp $NoxinBundle "${PveSsh}:/root/noxin-ai.tar"
```

Przy wyborze katalogu projektu i zawartości paczki trzymaj się tych dwóch ścieżek. Dane logowania Django i plik `.env` są poza pakietem. Moduł nie wymaga uruchomienia Django ani bazy danych.

## 3. Kontener i instalacja

Na hoście Proxmox jako root rozpakuj paczkę, uruchom audyt, a następnie odczytaj listę szablonów. Przykładowe wartości adresu, wolnego ID, składowiska i nazwy szablonu dostosuj do wyników audytu. Przydziel adres spoza puli dynamicznej DHCP lub zarezerwuj go w routerze.

```bash
mkdir -p /root/noxin-bundle
tar -xf /root/noxin-ai.tar -C /root/noxin-bundle
cd /root/noxin-bundle
bash deploy/ai/audit-proxmox.sh
pveam update
pveam available --section system | grep debian-13-standard
```

```bash
CTID=210
CT_IP=192.168.1.50
CT_GATEWAY=192.168.1.1
CT_LAN=192.168.1.0/24
CT_ROOT_STORAGE=local-lvm
CT_TEMPLATE_STORAGE=local
AI_USER=noxin
read -r -p 'Nazwa szablonu Debian 13 z pveam available: ' CT_TEMPLATE
pveam download "$CT_TEMPLATE_STORAGE" "$CT_TEMPLATE"
bash deploy/ai/create-lxc.sh "$CTID" "$CT_TEMPLATE_STORAGE:vztmpl/$CT_TEMPLATE" \
  "$CT_ROOT_STORAGE" "$CT_IP/24" "$CT_GATEWAY"
pct push "$CTID" /root/noxin-ai.tar /root/noxin-ai.tar
pct exec "$CTID" -- mkdir -p /root/noxin-bundle
pct exec "$CTID" -- tar -xf /root/noxin-ai.tar -C /root/noxin-bundle
pct enter "$CTID"
```

W kontenerze użyj uzgodnionego adresu IP, CIDR i użytkownika. Wpisz hasło w interaktywnym monicie. Instalator pobierze pakiety, skompiluje przypięte wydanie `llama.cpp` bez AVX, AVX2 i FMA, pobierze Qwen3.5 0.8B Q4_0 i sprawdzi SHA-256. Następnie uruchomi model z 4 wątkami, pojedynczym slotem i kontekstem 2048 tokenów, sprawdzi start usług i dostęp HTTPS bez hasła. Budowa na J4105 może potrwać.

```bash
cd /root/noxin-bundle
bash deploy/ai/install.sh noxin-front/dist 192.168.1.50 192.168.1.0/24 noxin
python3 deploy/ai/smoke-test.py
```

Jeżeli tworzenie przerwało się po przydzieleniu ID, sprawdź `pct config ID` i `pct status ID`. Możesz kontynuować z istniejącym kontenerem Noxin. Instalator można wznowić w tym kontenerze tymi samymi argumentami do chwili zakończenia instalacji.

## 4. Zaufanie do HTTPS

Na hoście Proxmox zapisz publiczny certyfikat CA wygenerowany w LXC. Odcisk SHA-256 porównaj z wyjściem instalatora przez zaufany kanał. Plik `root.crt` przenieś na komputer i telefon. Pliki kluczy CA zostaw w LXC i chronionej kopii zapasowej.

```bash
pct pull "$CTID" /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt /root/noxin-ai-ca.crt
openssl x509 -in /root/noxin-ai-ca.crt -noout -fingerprint -sha256
```

Dodaj CA do zaufanych certyfikatów na komputerze i telefonie. W Windows wybierz magazyn „Zaufane główne urzędy certyfikacji” bieżącego użytkownika. W iOS po instalacji profilu włącz pełne zaufanie do certyfikatu w ustawieniach zaufania certyfikatów. Na Androidzie użyj instalacji certyfikatu CA w ustawieniach bezpieczeństwa. Jeżeli przeglądarka używa własnego magazynu certyfikatów, importuj CA również tam.

Otwórz `https://192.168.1.50/#/moduly/ai` i `https://192.168.1.50:8443/`. Użyj konta Caddy. Na routerze pozostaw wyłączone przekierowania portów do LXC. Gdy filtrujesz ruch na poziomie routera lub Proxmoxa, dopuść z zaufanej podsieci TCP 443 i 8443.

## 5. Odbiór

- Uruchom `python3 deploy/ai/smoke-test.py` w kontenerze. Sprawdza rozmowę po polsku, ekstrakcję PDF, DOCX i skan faktury oraz podaje czasy dwóch odpowiedzi. Skan testowy powinien zwrócić numer 6438 i kwotę 123,00 PLN. Odpowiedzi modelu porównaj z fragmentami źródłowymi.
- Na komputerze i telefonie sprawdź logowanie do obu interfejsów, rozmowę i wysłanie testowego dokumentu z Noxin. Sprawdź, czy bez logowania pojawia się żądanie hasła oraz czy urządzenie spoza zaufanego CIDR nie uzyskuje dostępu.
- Obserwuj `top`, `free -h` i `df -h /` podczas generowania i OCR. Szczyt pamięci oraz skumulowany czas CPU pokaże `systemctl show noxin-ai-model noxin-ai-documents -p MemoryPeak -p CPUUsageNSec`. `ss -lntp` powinien pokazywać dwa porty LAN Caddy oraz port Agenta `8090` wyłącznie na `127.0.0.1`. `ss -lx` pokaże gniazda usług AI.
- Na routerze czasowo zablokuj temu LXC wyjście do Internetu przy zachowaniu LAN, również dla IPv6, jeżeli jest używany. Powtórz smoke test i sprawdź oba interfejsy z telefonu. Przywróć pierwotną regułę po teście.
- Zweryfikuj odzyskanie po awarii w oknie testowym, gdy nikt nie korzysta z czatu. W LXC uruchom `systemctl kill --signal=SIGKILL --kill-whom=main noxin-ai-model`, a potem `bash deploy/ai/wait-ready.sh`. `systemctl show noxin-ai-model -p NRestarts` powinno pokazać restart. W oddzielnym oknie sprawdź, czy LXC i usługi wstają po restarcie hosta.

## 6. Agent AI na innym urządzeniu

Adres Agenta ustawiasz w `/etc/caddy/noxin-agent.caddy` **w kontenerze Noxin**. Przy wspólnym LXC domyślna konfiguracja kieruje żądania na `http://127.0.0.1:8090`. Przeglądarka komputera i telefonu korzysta z własnego adresu Noxin oraz ścieżek `/api/ai/*`; zmiana Agenta wymaga przeładowania Caddy.

Jeżeli przeniesiesz Agenta na inne urządzenie, użyj jego prywatnego adresu HTTPS. Agent powinien udostępniać to samo API `/api/ai/*` przez Caddy (port 443 w tej instrukcji) i dopuszczać adres źródłowy kontenera Noxin. Port Gunicorna 8090 pozostaje na pętli lokalnej urządzenia z Agentem. Przekaż na Noxin publiczny certyfikat CA Agenta, po sprawdzeniu odcisku SHA-256, i zainstaluj go jako `/etc/caddy/noxin-agent-ca.crt`.

Przykładowa zawartość `/etc/caddy/noxin-agent.caddy` dla Agenta pod `192.168.1.60` z Basic Auth.

```caddyfile
reverse_proxy https://192.168.1.60:443 {
	header_up Host {upstream_hostport}
	header_up -Cookie
	header_up Authorization "Basic KOD_BASE64"
	header_down -WWW-Authenticate
	transport http {
		tls_trusted_ca_certs /etc/caddy/noxin-agent-ca.crt
	}
}
```

W miejsce `KOD_BASE64` wstaw Base64 ciągu `użytkownik:hasło` konta na urządzeniu z Agentem. Traktuj ten zapis jak hasło i przechowuj go wyłącznie w pliku `root:caddy` o trybie `0640`. Caddy użyje tego konta przy połączeniu z Agentem. Użytkownicy nadal logują się do Noxin swoim kontem.

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
```

Po przeładowaniu otwórz Noxin i sprawdź status modelu oraz wyślij testową wiadomość. Aby wrócić do lokalnego Agenta, przywróć domyślną zawartość `noxin-agent.caddy` z pakietu, uruchom lokalne usługi AI i ponownie przeładuj Caddy. Wbudowany Llama Chat dla przeniesionego modelu otworzysz pod portem `8443` urządzenia z Agentem.

Jeśli LXC korzysta już z wcześniejszej wersji wdrożenia, zainstaluj z nowego pakietu `noxin-ai-gateway.service` i `noxin-agent.caddy`.

```bash
cd /root/noxin-bundle
install -m 0644 deploy/ai/noxin-ai-gateway.service /etc/systemd/system/
install -o root -g caddy -m 0640 deploy/ai/noxin-agent.caddy /etc/caddy/
systemctl daemon-reload
systemctl restart noxin-ai-gateway
curl --fail http://127.0.0.1:8090/api/ai/health
```

W `/etc/caddy/Caddyfile` zastąp zawartość bloku `handle /api/ai/*` dyrektywą `import /etc/caddy/noxin-agent.caddy`, po czym wykonaj powyższą walidację i przeładuj Caddy. [Konfiguracja reverse proxy Caddy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## 7. Dostęp do publicznych stron

Domyślnie wyłączony. W `/etc/noxin-ai/runtime.env` ustaw `NOXIN_AI_PUBLIC_WEB=1` i wykonaj `systemctl restart noxin-ai-gateway`. W Noxin wklej publiczny adres HTTPS i wybierz „Pobierz tekst strony”. Funkcja pobiera HTML lub tekst po publicznym IPv4, bez przekierowań i parametrów adresu. Strona widzi zwykłe żądanie pobrania podanego URL. Pytania, historia, pliki i wynik analizy przepływają wyłącznie przez LAN i gniazda lokalne. Do modelu trafia do 1800 znaków pobranego tekstu po wysłaniu wiadomości.

## 8. Aktualizacja i przywracanie

W prostej konfiguracji LXC cały model, dane CA, konfiguracja Caddy i pliki aplikacji są w systemie plików kontenera. Na hoście utwórz kopię na osobnym składowisku przeznaczonym na backupy. Tryb `stop` na czas tworzenia kopii zatrzymuje kontener.

```bash
vzdump "$CTID" --mode stop --storage "$CT_BACKUP_STORAGE"
pvesm list "$CT_BACKUP_STORAGE" --content backup
```

Po kopii, wewnątrz LXC, zaktualizuj system przez `apt-get update` i `apt-get upgrade`. Dla nowszego wydania silnika zbuduj kandydata bez podmiany aktualnej binarki.

```bash
cd /root/noxin-bundle
read -r -p 'Tag wydania llama.cpp: ' LLAMA_TAG
bash deploy/ai/build-llama.sh "$LLAMA_TAG" /opt/noxin-ai/llama-server.next
cp -a /opt/noxin-ai/llama-server /opt/noxin-ai/llama-server.previous
mv -T /opt/noxin-ai/llama-server.next /opt/noxin-ai/llama-server
systemctl restart noxin-ai-model
bash deploy/ai/wait-ready.sh
python3 deploy/ai/smoke-test.py
```

Gdy test się nie powiedzie, odtwórz binarkę z `llama-server.previous` przez `cp -a` do `llama-server.next`, a następnie `mv -T` i ponów sprawdzanie po restarcie modelu. Aktualizując sam moduł, zbuduj paczkę zgodnie z etapem 2, przygotuj nowy katalog statyczny z `dist` i podmień go na `/opt/noxin-ai/site`, zostawiając poprzedni katalog do wycofania. Kopiując nowe pliki `gateway.py`, `documents.py` i `public_web.py` do `/opt/noxin-ai/app`, uruchom ponownie obie usługi Pythona i wykonaj smoke test. Pliki jednostek po podmianie wymagają `systemctl daemon-reload`. Przed zmianą Caddyfile wykonaj kopię i zweryfikuj kandydata przez `caddy validate --config <plik> --adapter caddyfile`, a po podmianie zrób `systemctl reload caddy`. Nie umieszczaj konfiguracji z hashem, kopii ani kluczy CA w repozytorium.

Alternatywny [Qwen3 1.7B Q4](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF) możesz przetestować po zapisaniu dotychczasowego `runtime.env`. Pobierz GGUF do `/opt/noxin-ai/models/`, zweryfikuj SHA-256 ze strony pliku i zmień `NOXIN_AI_MODEL` na ścieżkę do niego. Kontekst można przestawić na 4096 przez `NOXIN_AI_CONTEXT=4096`. Po każdej zmianie uruchom `systemctl restart noxin-ai-model noxin-ai-gateway`, sprawdź RAM i czasy generowania. Żeby wrócić do poprzednich ustawień, przywróć kopię `runtime.env` i ponownie uruchom obie usługi.

Do odtworzenia całego LXC użyj wolnego ID, składowiska z miejscem na rootfs i lokalnej kopii. Wartość `CT_BACKUP_VOLUME` odczytaj z `pvesm list`. Odtworzony LXC będzie miał ten sam IP, więc uruchom go dopiero po wyłączeniu pierwotnego albo odtwórz go na odizolowanym moście. Przy zachowaniu IP i kopii CA urządzenia zachowują dotychczasowe zaufanie HTTPS.

```bash
pct restore "$CT_RESTORE_ID" "$CT_BACKUP_VOLUME" --storage "$CT_ROOT_STORAGE" --onboot 0 --unique 1
pct config "$CT_RESTORE_ID"
# Po zwolnieniu adresu przez pierwotny LXC
pct start "$CT_RESTORE_ID"
pct exec "$CT_RESTORE_ID" -- bash /root/noxin-bundle/deploy/ai/wait-ready.sh
pct exec "$CT_RESTORE_ID" -- python3 /root/noxin-bundle/deploy/ai/smoke-test.py
pct set "$CT_RESTORE_ID" --onboot 1
```

Dokumentacja źródłowa. [Proxmox VE](https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf) · [Budowanie llama.cpp](https://github.com/ggml-org/llama.cpp/blob/b12244/docs/build.md) · [Model GGUF i SHA-256](https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/blob/9447f74101aeb4e93621884dfa36ee8effb8831b/Qwen3.5-0.8B-Q4_0.gguf) · [Certyfikaty Caddy](https://caddyserver.com/docs/running#local-https-with-systemd)
