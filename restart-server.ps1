#!/usr/bin/env pwsh
# Quick Restart Script for Medusa Server

Write-Host "🔄 Restarting Medusa Server..." -ForegroundColor Cyan

# Stop existing node processes (be careful if you have other node apps running)
Write-Host "`n1️⃣ Stopping existing Medusa processes..." -ForegroundColor Yellow
Get-Process node -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -like "*pranajiva*" -or $_.CommandLine -like "*medusa*"
} | Stop-Process -Force

Start-Sleep -Seconds 2

# Navigate to backend directory
Set-Location "c:\Personal\PranaJiva\v1\Backend\pranajiva-backend"

Write-Host "`n2️⃣ Starting Medusa in production mode..." -ForegroundColor Yellow
Write-Host "   Server will be available at: http://localhost:9001" -ForegroundColor Gray
Write-Host "   Admin will be available at: http://localhost:9001/app" -ForegroundColor Gray

# Start the server
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd c:\Personal\PranaJiva\v1\Backend\pranajiva-backend; npm run start:prod"

Write-Host "`n✅ Server starting in new window..." -ForegroundColor Green
Write-Host "`n3️⃣ Waiting 10 seconds for server to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

# Test the API
Write-Host "`n4️⃣ Testing product categories API..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "http://localhost:9001/store/product-categories" -Method Get
    Write-Host "✅ API Response:" -ForegroundColor Green
    Write-Host "   Categories found: $($response.count)" -ForegroundColor Green
    $response.product_categories | ForEach-Object {
        Write-Host "   - $($_.name) ($($_.handle))" -ForegroundColor Green
    }
} catch {
    Write-Host "⚠️  Server not ready yet or not accessible on localhost" -ForegroundColor Red
    Write-Host "   Try accessing http://13.60.64.87:9001/store/product-categories in browser" -ForegroundColor Yellow
}

Write-Host "`n🎉 Done! Check the admin panel to verify:" -ForegroundColor Cyan
Write-Host "   - Product Categories should now appear" -ForegroundColor Gray
Write-Host "   - Settings → Regions → India should show payment & shipping" -ForegroundColor Gray
