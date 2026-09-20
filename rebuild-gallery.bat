@echo off
REM Double-click this file after you add or remove photos in assets\gallery
REM It rebuilds the gallery list so the new photos show up on the website.
cd /d "%~dp0assets\gallery"
node -e "const fs=require('fs');const re=/\.(jpg|jpeg|png|webp|gif|mp4|webm|mov)$/i;const files=fs.readdirSync('.').filter(f=>re.test(f)).sort();fs.writeFileSync('gallery.json',JSON.stringify(files.map(f=>'/assets/gallery/'+f)));console.log('Done. Gallery now has '+files.length+' items.');"
echo.
echo Now re-publish your website (drag the royalinn-site folder to Netlify again).
pause
