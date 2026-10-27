// Generated display pattern only. No screen reading, input injection or permission prompts.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

@interface CapturePattern : NSView
@property(nonatomic) BOOL alternate;
@end
@implementation CapturePattern
- (BOOL)acceptsFirstResponder { return YES; }
- (void)keyDown:(NSEvent *)event {
    if (event.keyCode == 53) { printf("PATTERN_CANCELLED\n"); fflush(stdout); [NSApp terminate:nil]; }
}
- (void)drawRect:(NSRect)dirty {
    [NSColor.darkGrayColor setFill];
    NSRectFill(self.bounds);
    [NSColor.grayColor setFill];
    NSRectFill(NSMakeRect(self.alternate ? 80 : 40, 40, 160, 160));
    [@"OpenBitFun capture check — Escape to close" drawAtPoint:NSMakePoint(40, 230)
        withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:20], NSForegroundColorAttributeName:NSColor.lightGrayColor}];
}
@end

@interface CapturePatternWindow : NSWindow
@end
@implementation CapturePatternWindow
- (BOOL)canBecomeKeyWindow { return YES; }
@end

static BOOL matches(NSScreen *screen, NSString *expected) {
    NSNumber *identifier = screen.deviceDescription[@"NSScreenNumber"];
    CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(identifier.unsignedIntValue);
    if (!uuid) return NO;
    CFStringRef value = CFUUIDCreateString(NULL, uuid);
    CFRelease(uuid);
    if (!value) return NO;
    BOOL result = [[(__bridge NSString *)value lowercaseString] isEqualToString:expected];
    CFRelease(value);
    return result;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 2) return 2;
        NSString *expected = [NSString stringWithUTF8String:argv[1]];
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSScreen *selected = nil;
        for (NSScreen *screen in NSScreen.screens) if (matches(screen, expected)) { selected = screen; break; }
        if (!selected) return 3;
        NSWindow *window = [[CapturePatternWindow alloc] initWithContentRect:selected.frame
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.level = NSStatusWindowLevel;
        window.hasShadow = NO;
        // Consume interaction in this disposable window rather than letting
        // clicks pass through an opaque pattern to an unseen application.
        window.ignoresMouseEvents = NO;
        window.releasedWhenClosed = NO;
        CapturePattern *pattern = [[CapturePattern alloc] initWithFrame:window.contentView.bounds];
        window.contentView = pattern;
        [window makeKeyAndOrderFront:nil];
        [window makeFirstResponder:pattern];
        [NSApp activateIgnoringOtherApps:YES];
        [pattern display];
        // Four seconds of generated changes, then unchanged content. This does
        // not prove the rest of the selected source is static (cursor/OS UI).
        __block NSUInteger ticks = 0;
        NSTimer *timer = [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *tick) {
            if (!matches(selected, expected) || !NSEqualRects(window.frame, selected.frame)) {
                fprintf(stderr, "Selected pattern display changed\n");
                [NSApp terminate:nil];
                return;
            }
            pattern.alternate = !pattern.alternate;
            [pattern setNeedsDisplay:YES];
            if (++ticks == 40) {
                [tick invalidate];
                printf("PATTERN_STATIC\n"); fflush(stdout);
            }
        }];
        (void)timer;
        printf("PATTERN_READY\n"); fflush(stdout);
        // Bound fixture lifetime independently of the runner.
        [NSTimer scheduledTimerWithTimeInterval:20 repeats:NO block:^(NSTimer *tick) {
            printf("PATTERN_FINISHED\n"); fflush(stdout); [NSApp terminate:nil];
        }];
        [NSApp run];
    }
    return 0;
}
