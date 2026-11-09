import AppKit
import CoreText
import Foundation
import ImageIO
import PDFKit
import Vision

struct ExtractionFailure: Error {
    let status: Int
    let message: String
}
struct ExtractedPage: Codable {
    let page: Int
    let text: String
    let method: String
}
struct ExtractedDocument: Codable {
    let pages: [ExtractedPage]
    let warnings: [String]
}

func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US", "fr-FR"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

func render(_ page: PDFPage) throws -> CGImage {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0 else {
        throw ExtractionFailure(status: 422, message: "A PDF page has invalid dimensions.")
    }
    let scale = min(3, 3200 / max(bounds.width, bounds.height))
    let width = max(1, Int(ceil(bounds.width * scale))), height = max(1, Int(ceil(bounds.height * scale)))
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw ExtractionFailure(status: 422, message: "This page could not be prepared for text recognition.")
    }
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.scaleBy(x: scale, y: scale)
    context.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
    page.draw(with: .mediaBox, to: context)
    guard let image = context.makeImage() else { throw ExtractionFailure(status: 422, message: "This PDF page could not be read.") }
    return image
}

func extract(_ url: URL) throws -> ExtractedDocument {
    var pages: [ExtractedPage] = []
    if url.pathExtension.lowercased() == "pdf" {
        guard let document = PDFDocument(url: url) else { throw ExtractionFailure(status: 422, message: "This PDF could not be opened. Try another copy of the original.") }
        guard !document.isLocked else { throw ExtractionFailure(status: 422, message: "This PDF is password protected. Unlock a local copy before extracting text.") }
        guard document.pageCount > 0, document.pageCount <= 20 else { throw ExtractionFailure(status: 413, message: "Extract text from a PDF containing 1 to 20 pages. Split a longer document first.") }
        for index in 0..<document.pageCount {
            let result: ExtractedPage = try autoreleasepool {
                guard let page = document.page(at: index) else { throw ExtractionFailure(status: 422, message: "A PDF page could not be opened.") }
                let selectable = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !selectable.isEmpty { return ExtractedPage(page: index + 1, text: selectable, method: "pdf-text") }
                return ExtractedPage(page: index + 1, text: try recognize(render(page)), method: "ocr")
            }
            guard result.text.utf8.count <= 100_000 else { throw ExtractionFailure(status: 413, message: "One page contains too much text. Extract a smaller document.") }
            pages.append(result)
        }
    } else {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) == 1 else {
            throw ExtractionFailure(status: 422, message: "Choose a single PNG, JPEG, or HEIC image that this Mac can open.")
        }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 3200, kCGImageSourceShouldCacheImmediately: true]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw ExtractionFailure(status: 422, message: "This image could not be read.") }
        pages = [ExtractedPage(page: 1, text: try recognize(image), method: "ocr")]
    }
    guard pages.reduce(0, { $0 + $1.text.utf8.count }) <= 500_000 else { throw ExtractionFailure(status: 413, message: "This document contains too much text. Split it into smaller files.") }
    var warnings = ["Compare extracted text with the original. Amounts, columns, signs, and dates can be read incorrectly."]
    if pages.contains(where: { $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { warnings.append("No text was found on one or more pages. Enter their details from the original.") }
    return ExtractedDocument(pages: pages, warnings: warnings)
}

func selfTest() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mazal-extract-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    let pdf = directory.appendingPathComponent("test.pdf")
    var mediaBox = CGRect(x: 0, y: 0, width: 612, height: 792)
    guard let context = CGContext(pdf as CFURL, mediaBox: &mediaBox, nil) else { throw ExtractionFailure(status: 500, message: "Test PDF could not be created.") }
    context.beginPDFPage(nil)
    let text = NSAttributedString(string: "Mazal payroll 123.45", attributes: [.font: NSFont.systemFont(ofSize: 28)])
    context.textPosition = CGPoint(x: 60, y: 680)
    CTLineDraw(CTLineCreateWithAttributedString(text), context)
    context.endPDFPage()
    context.closePDF()
    let result = try extract(pdf)
    guard result.pages.count == 1, result.pages[0].method == "pdf-text", result.pages[0].text.contains("123.45") else { throw ExtractionFailure(status: 500, message: "Selectable PDF text check failed.") }
    guard let document = PDFDocument(url: pdf), let page = document.page(at: 0) else { throw ExtractionFailure(status: 500, message: "Test PDF page missing.") }
    let image = try withExtendedLifetime(document) { try render(page) }
    let png = directory.appendingPathComponent("test.png")
    guard let destination = CGImageDestinationCreateWithURL(png as CFURL, "public.png" as CFString, 1, nil) else { throw ExtractionFailure(status: 500, message: "Test image could not be created.") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw ExtractionFailure(status: 500, message: "Test image could not be saved.") }
    let recognized = try extract(png)
    guard recognized.pages[0].method == "ocr", recognized.pages[0].text.contains("123.45") else { throw ExtractionFailure(status: 500, message: "Image recognition check failed.") }
    print("Local PDF text and image recognition passed.")
}

do {
    if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--self-test" {
        try selfTest()
    } else {
        guard CommandLine.arguments.count == 2 else { throw ExtractionFailure(status: 400, message: "Provide one local document path.") }
        let result = try extract(URL(fileURLWithPath: CommandLine.arguments[1]))
        FileHandle.standardOutput.write(try JSONEncoder().encode(result))
    }
} catch {
    let failure = error as? ExtractionFailure ?? ExtractionFailure(status: 422, message: "This Mac could not recognize the document. Review the original and enter its details manually.")
    if let data = try? JSONSerialization.data(withJSONObject: ["status": failure.status, "error": failure.message]) { FileHandle.standardOutput.write(data) }
    exit(1)
}
