# Minimal static file server for Ashfall Arena.
#   powershell -ExecutionPolicy Bypass -File serve.ps1
# Then open http://localhost:8080
#
# Model files must be served over HTTP: browsers block file:// XHR, and
# FBXLoader/GLTFLoader hang rather than reporting an error when they hit it.

param([int]$Port = 8080)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")

$types = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "application/javascript"
  ".css"  = "text/css"
  ".json" = "application/json"
  ".glb"  = "model/gltf-binary"
  ".gltf" = "model/gltf+json"
  ".fbx"  = "application/octet-stream"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".mp3"  = "audio/mpeg"
  ".wav"  = "audio/wav"
  ".md"   = "text/markdown; charset=utf-8"
}

try {
  $listener.Start()
} catch {
  Write-Host "Could not bind port $Port. Try: serve.ps1 -Port 8090"
  exit 1
}
Write-Host "Ashfall Arena -> http://localhost:$Port   (Ctrl+C to stop)"

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $rel = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart("/"))
    if ([string]::IsNullOrWhiteSpace($rel)) { $rel = "index.html" }

    $path = Join-Path $root $rel
    $full = [System.IO.Path]::GetFullPath($path)

    # never serve outside the project folder
    if (-not $full.StartsWith([System.IO.Path]::GetFullPath($root))) {
      $ctx.Response.StatusCode = 403
      $ctx.Response.Close()
      continue
    }

    if (Test-Path $full -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ctx.Response.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ctx.Response.ContentLength64 = $bytes.Length
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 $rel")
      $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
    }
    $ctx.Response.Close()
  } catch {
    # a dropped connection should never take the server down
  }
}
