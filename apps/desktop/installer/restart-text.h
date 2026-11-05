#pragma once
#include <d2d1.h>
#include <dwrite.h>
#include <wrl/client.h>
#include <cmath>

// Optional graphics libraries are loaded only in the status process. Keep the GDI dimensions
// until the complete DirectWrite bitmap is available, including a successful EndDraw.
static HBITMAP RenderRestartParagraph(HWND window, LPCWSTR text, LPCWSTR face, LPCWSTR locale,
        int logicalSize, int width, UINT dpi, COLORREF background, COLORREF foreground, LONG& height) {
    using Microsoft::WRL::ComPtr;
    HMODULE write = LoadLibraryExW(L"dwrite.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    HMODULE draw = LoadLibraryExW(L"d2d1.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!write || !draw) return nullptr;
    // Both libraries stay loaded for the lifetime of this single-window process.
#pragma warning(push)
#pragma warning(disable: 4191)
    auto createWrite = reinterpret_cast<decltype(&DWriteCreateFactory)>(GetProcAddress(write, "DWriteCreateFactory"));
    using CreateDraw = HRESULT(WINAPI*)(D2D1_FACTORY_TYPE, REFIID, const D2D1_FACTORY_OPTIONS*, void**);
    auto createDraw = reinterpret_cast<CreateDraw>(GetProcAddress(draw, "D2D1CreateFactory"));
#pragma warning(pop)
    if (!createWrite || !createDraw) return nullptr;
    ComPtr<IDWriteFactory> factory;
    ComPtr<IDWriteTextFormat> format;
    ComPtr<IDWriteTextLayout> layout;
    ComPtr<ID2D1Factory> graphics;
    ComPtr<ID2D1DCRenderTarget> target;
    ComPtr<ID2D1SolidColorBrush> brush;
    const float scale = dpi / 96.0f;
    if (FAILED(createWrite(DWRITE_FACTORY_TYPE_SHARED, __uuidof(IDWriteFactory), reinterpret_cast<IUnknown**>(factory.GetAddressOf()))) ||
        FAILED(factory->CreateTextFormat(face, nullptr, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_FONT_STYLE_NORMAL,
            DWRITE_FONT_STRETCH_NORMAL, static_cast<float>(logicalSize), locale, &format)) ||
        FAILED(format->SetWordWrapping(DWRITE_WORD_WRAPPING_EMERGENCY_BREAK)) ||
        FAILED(factory->CreateTextLayout(text, static_cast<UINT32>(wcslen(text)), format.Get(), width / scale, 4096, &layout)) ||
        FAILED(createDraw(D2D1_FACTORY_TYPE_SINGLE_THREADED, __uuidof(ID2D1Factory), nullptr, reinterpret_cast<void**>(graphics.GetAddressOf())))) return nullptr;
    DWRITE_TEXT_METRICS metrics{};
    if (FAILED(layout->GetMetrics(&metrics))) return nullptr;
    const LONG bitmapHeight = static_cast<LONG>(std::ceil(metrics.height * scale));
    const auto props = D2D1::RenderTargetProperties(D2D1_RENDER_TARGET_TYPE_SOFTWARE,
        D2D1::PixelFormat(DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_IGNORE), static_cast<float>(dpi), static_cast<float>(dpi));
    if (FAILED(graphics->CreateDCRenderTarget(&props, &target))) return nullptr;
    HDC screen = GetDC(window);
    if (!screen) return nullptr;
    HDC dc = CreateCompatibleDC(screen);
    HBITMAP bitmap = CreateCompatibleBitmap(screen, width, bitmapHeight);
    ReleaseDC(window, screen);
    const auto color = [](COLORREF c) { return D2D1::ColorF(GetRValue(c)/255.f, GetGValue(c)/255.f, GetBValue(c)/255.f); };
    const RECT bounds{0, 0, width, bitmapHeight};
    HGDIOBJ old = dc && bitmap ? SelectObject(dc, bitmap) : nullptr;
    bool painted = false;
    if (old && SUCCEEDED(target->BindDC(dc, &bounds)) && SUCCEEDED(target->CreateSolidColorBrush(color(foreground), &brush))) {
        target->BeginDraw();
        target->Clear(color(background));
        target->DrawTextLayout(D2D1::Point2F(), layout.Get(), brush.Get());
        painted = SUCCEEDED(target->EndDraw());
    }
    if (old) SelectObject(dc, old);
    if (dc) DeleteDC(dc);
    if (!painted) { DeleteObject(bitmap); return nullptr; }
    height = bitmapHeight;
    return bitmap;
}
