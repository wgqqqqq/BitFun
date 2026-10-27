// Display-only ScreenCaptureKit source. No audio, input, screenshots or window fallback.
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <stdatomic.h>
#include <math.h>

typedef void (*OBFDisplayFrame)(void *, CVPixelBufferRef, int64_t);
typedef void (*OBFDisplayState)(void *, int32_t); // 1=started, 2=idle, 3=unobservable, -1=failed, -2=geometry changed, -4=locked/unavailable session
bool obf_rd_input_session_available(void);

int32_t obf_rd_display_availability(void) {
    if (@available(macOS 14.0, *)) return CGPreflightScreenCaptureAccess() ? (obf_rd_input_session_available() ? 2 : 3) : 1;
    return 0;
}

// Read-only session witness for foreground input. No wake/unlock or prompt.
bool obf_rd_input_session_available(void) {
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    NSNumber *console = session[(__bridge NSString *)kCGSessionOnConsoleKey];
    NSNumber *loggedIn = session[(__bridge NSString *)kCGSessionLoginDoneKey];
    NSNumber *locked = session[@"CGSSessionScreenIsLocked"];
    return [console isKindOfClass:NSNumber.class] && console.boolValue
        && [loggedIn isKindOfClass:NSNumber.class] && loggedIn.boolValue
        && (!locked || ([locked isKindOfClass:NSNumber.class] && !locked.boolValue));
}

double obf_rd_double_click_interval(void) {
    return [NSEvent doubleClickInterval];
}

// Track physical rendering pixels independently from Quartz input bounds.
// A HiDPI scale-only mode change must also retire the old source geometry.
static BOOL obf_display_pixel_size(uint32_t display, size_t *width, size_t *height) {
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(display);
    if (!mode) return NO;
    *width = CGDisplayModeGetPixelWidth(mode); *height = CGDisplayModeGetPixelHeight(mode);
    CGDisplayModeRelease(mode);
    return *width >= 2 && *height >= 2;
}

@interface OBFDisplaySource : NSObject <SCStreamOutput, SCStreamDelegate> {
@public _Atomic(bool) closing;
}
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic) void *context;
@property(nonatomic) OBFDisplayFrame frame;
@property(nonatomic) OBFDisplayState state;
@property(nonatomic) uint32_t display;
@property(nonatomic) CGRect bounds;
@property(nonatomic) double rotation;
@property(nonatomic) size_t pixelWidth;
@property(nonatomic) size_t pixelHeight;
@property(nonatomic, copy) NSString *uuid;
@property(nonatomic, strong) NSCondition *condition;
@property(nonatomic) BOOL preparationFinished;
@property(nonatomic) BOOL stopped;
@property(nonatomic) BOOL captureStarted;
@end
static BOOL obf_display_uuid_matches(uint32_t display, NSString *expected);
@implementation OBFDisplaySource
- (void)report:(int32_t)state {
    if (!atomic_load(&closing) && self.context && self.state) self.state(self.context, state);
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if (atomic_load(&closing) || type != SCStreamOutputTypeScreen) return;
    if (!sample || !CMSampleBufferIsValid(sample)) { [self report:3]; return; }
    if (!CGPreflightScreenCaptureAccess()) {
        [self report:-1]; atomic_store(&closing, true); return;
    }
    if (!obf_rd_input_session_available()) {
        [self report:-4]; atomic_store(&closing, true); return;
    }
    size_t pixelWidth = 0, pixelHeight = 0;
    if (!CGDisplayIsActive(self.display) || !obf_display_uuid_matches(self.display, self.uuid)
        || !CGRectEqualToRect(CGDisplayBounds(self.display), self.bounds)
        || CGDisplayRotation(self.display) != self.rotation
        || !obf_display_pixel_size(self.display, &pixelWidth, &pixelHeight)
        || pixelWidth != self.pixelWidth || pixelHeight != self.pixelHeight) {
        [self report:-2]; atomic_store(&closing, true); return;
    }
    NSArray *info = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, NO);
    NSNumber *status = info.count ? info[0][SCStreamFrameInfoStatus] : nil;
    if (status.integerValue == SCFrameStatusIdle && status) { [self report:2]; return; }
    if (!status || status.integerValue != SCFrameStatusComplete) { [self report:3]; return; }
    CVPixelBufferRef buffer = CMSampleBufferGetImageBuffer(sample);
    CMTime time = CMSampleBufferGetPresentationTimeStamp(sample);
    if (!buffer || !CMTIME_IS_NUMERIC(time)) { [self report:3]; return; }
    double micros = CMTimeGetSeconds(time) * 1000000.0;
    if (!isfinite(micros) || micros < 0 || micros >= (double)INT64_MAX) { [self report:3]; return; }
    if (self.context && self.frame) self.frame(self.context, buffer, (int64_t)micros);
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    dispatch_async(self.queue, ^{ [self report:-1]; [self.condition lock]; self.stopped = YES; [self.condition broadcast]; [self.condition unlock]; });
}
@end

static BOOL obf_display_uuid_matches(uint32_t display, NSString *expected) {
    CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(display);
    if (!uuid) return NO;
    CFStringRef string = CFUUIDCreateString(kCFAllocatorDefault, uuid); CFRelease(uuid);
    if (!string) return NO;
    BOOL matches = [[(__bridge NSString *)string lowercaseString] isEqualToString:expected];
    CFRelease(string); return matches;
}

// Called on a worker, never the main thread. Returns before capture callbacks
// are allowed to outlive their context; destroy must confirm callback drainage.
void *obf_rd_display_open(uint32_t display, const char *uuid, uint32_t width, uint32_t height,
                          uint32_t fps, void *context, OBFDisplayFrame frame, OBFDisplayState state) {
    @autoreleasepool {
    if (@available(macOS 14.0, *)) {
        if (NSThread.isMainThread || !uuid || !context || !frame || !state || !width || !height || !fps || fps > 60) return NULL;
        if (!CGPreflightScreenCaptureAccess()) return NULL; // OS consent is local, never silently requested here.
        OBFDisplaySource *source = [OBFDisplaySource new];
        atomic_init(&source->closing, false);
        source.queue = dispatch_queue_create("openbitfun.remote-desktop.display",
            dispatch_queue_attr_make_with_autorelease_frequency(DISPATCH_QUEUE_SERIAL, DISPATCH_AUTORELEASE_FREQUENCY_WORK_ITEM));
        source.context = context; source.frame = frame; source.state = state; source.display = display;
        source.condition = [NSCondition new];
        NSString *expected = [NSString stringWithUTF8String:uuid];
        source.uuid = expected;
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
            dispatch_async(source.queue, ^{
                if (atomic_load(&source->closing)) {
                    [source.condition lock]; source.preparationFinished = YES; [source.condition broadcast]; [source.condition unlock]; return;
                }
                SCDisplay *selected = nil;
                for (SCDisplay *candidate in content.displays) if (candidate.displayID == display) { selected = candidate; break; }
                size_t pixelWidth = 0, pixelHeight = 0;
                if (error || !selected || !obf_display_uuid_matches(display, expected)
                    || !obf_display_pixel_size(display, &pixelWidth, &pixelHeight)
                    // The mode may change after Rust resolves the target. Never
                    // upscale or capture a different aspect using that old size.
                    || width > pixelWidth || height > pixelHeight
                    || fabsl((long double)width * pixelHeight - (long double)height * pixelWidth)
                        > 2.0L * MAX(pixelWidth, pixelHeight)) {
                    [source report:-1];
                    [source.condition lock]; source.preparationFinished = YES; [source.condition broadcast]; [source.condition unlock]; return;
                }
                source.bounds = CGDisplayBounds(display); source.rotation = CGDisplayRotation(display);
                source.pixelWidth = pixelWidth; source.pixelHeight = pixelHeight;
                SCStreamConfiguration *config = [SCStreamConfiguration new];
                config.width = width; config.height = height; config.minimumFrameInterval = CMTimeMake(1, fps);
                config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
                config.queueDepth = 3; config.showsCursor = YES; config.capturesAudio = NO;
                SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:selected excludingWindows:@[]];
                SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:source];
                source.stream = stream;
                NSError *outputError = nil;
                BOOL added = [stream addStreamOutput:source type:SCStreamOutputTypeScreen sampleHandlerQueue:source.queue error:&outputError];
                if (!added) {
                    [source report:-1];
                    [source.condition lock]; source.preparationFinished = YES; [source.condition broadcast]; [source.condition unlock]; return;
                }
                [stream startCaptureWithCompletionHandler:^(NSError *startError) {
                    dispatch_async(source.queue, ^{
                        source.captureStarted = !startError;
                        [source report:startError ? -1 : 1];
                        [source.condition lock]; source.preparationFinished = YES; [source.condition broadcast]; [source.condition unlock];
                    });
                }];
            });
        }];
        return (__bridge_retained void *)source;
    }
    return NULL;
    }
}

// Queued work retains its captures if the wait times out. It may finish later,
// but must never release the caller's handle or claim that drainage succeeded.
static bool obf_display_queue_before(dispatch_queue_t queue, dispatch_time_t deadline, dispatch_block_t action) {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    dispatch_async(queue, ^{ action(); dispatch_semaphore_signal(done); });
    return dispatch_semaphore_wait(done, deadline) == 0;
}

// On timeout retain the native handle/context; callers must quarantine it and
// keep their frame gate closed rather than falsely reporting cleanup complete.
bool obf_rd_display_destroy(void *handle) {
    @autoreleasepool {
    if (!handle || NSThread.isMainThread) return false;
    OBFDisplaySource *source = (__bridge OBFDisplaySource *)handle;
    atomic_store(&source->closing, true);
    dispatch_time_t queueDeadline = dispatch_time(DISPATCH_TIME_NOW, 8 * NSEC_PER_SEC);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:8];
    [source.condition lock];
    while (!source.preparationFinished && [source.condition waitUntilDate:deadline]) {}
    BOOL prepared = source.preparationFinished; [source.condition unlock];
    if (!prepared) return false;
    __block SCStream *stream;
    if (!obf_display_queue_before(source.queue, queueDeadline, ^{ source.context = NULL; stream = source.stream; })) return false;
    [source.condition lock];
    BOOL needsStop = stream && source.captureStarted && !source.stopped;
    [source.condition unlock];
    if (needsStop) {
        [stream stopCaptureWithCompletionHandler:^(NSError *error) {
            [source.condition lock]; source.stopped = !error; [source.condition broadcast]; [source.condition unlock];
        }];
        [source.condition lock];
        while (!source.stopped && [source.condition waitUntilDate:deadline]) {}
        BOOL stopped = source.stopped; [source.condition unlock];
        if (!stopped) return false;
    }
    if (!obf_display_queue_before(source.queue, queueDeadline, ^{ source.stream = nil; })) return false;
    CFBridgingRelease(handle); return true;
    }
}
