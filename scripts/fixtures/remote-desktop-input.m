// Disposable foreground canvas. Receipts contain fixed test counters only;
// never store user characters or inspect another application's content.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <math.h>

static NSString *resultPath;
static NSWindow *fixtureWindow;
static NSUInteger downs, ups, drags, keyDowns, keyUps, shiftedKeys, unexpectedKeys;
static BOOL shiftHeld;
static NSUInteger pointErrors;
static NSMutableArray *clicks;
static NSMutableArray *downTimes;
static NSMutableArray *quartzClickCounts;
static NSTextView *textView;
static NSUInteger textDowns, textUps;
static BOOL textMode, keyboardMode;
static NSUInteger focusClicks, backspaceDowns, backspaceUps, returnDowns, returnUps;
static NSString *expectedText(void) {
    return @"ABCDEFG\U0001f642\u4e2d\u6587e\u0301\U0001f469\u200d\U0001f4bb:0123456789012345678901234567890123456789";
}

static void publish(void) {
    NSScreen *screen = fixtureWindow.screen;
    NSNumber *screenNumber = screen.deviceDescription[@"NSScreenNumber"];
    uint32_t display = screenNumber.unsignedIntValue;
    CGRect bounds = CGDisplayBounds(display);
    NSPoint cocoa = [fixtureWindow convertPointToScreen:NSMakePoint(120,100)];
    double x = bounds.origin.x + cocoa.x - screen.frame.origin.x;
    double y = bounds.origin.y + NSMaxY(screen.frame) - cocoa.y;
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, (CGWindowID)fixtureWindow.windowNumber));
    NSDictionary *windowBounds = windows.firstObject[(__bridge NSString *)kCGWindowBounds];
    NSDictionary *state = @{
        @"pid":@(getpid()), @"window_id":@(fixtureWindow.windowNumber), @"display_id":@(display),
        @"display_x":@(bounds.origin.x), @"display_y":@(bounds.origin.y),
        @"display_width":@(bounds.size.width), @"display_height":@(bounds.size.height),
        @"pixel_width":@(CGDisplayPixelsWide(display)), @"pixel_height":@(CGDisplayPixelsHigh(display)),
        @"x":@(x), @"y":@(y), @"window_bounds":windowBounds ?: @{},
        @"active":@(NSApp.active), @"key_window":@(fixtureWindow.keyWindow),
        @"downs":@(downs), @"ups":@(ups), @"drags":@(drags), @"clicks":clicks,
        @"down_times":downTimes, @"quartz_click_counts":quartzClickCounts,
        @"double_click_interval":@([NSEvent doubleClickInterval]),
        @"key_downs":@(keyDowns), @"key_ups":@(keyUps), @"shifted_keys":@(shiftedKeys),
        @"shift_held":@(shiftHeld), @"unexpected_keys":@(unexpectedKeys)
        , @"left_held":@(CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft))
        , @"point_errors":@(pointErrors), @"text_downs":@(textDowns), @"text_ups":@(textUps),
        @"text_units":@(textView.string.length),
        @"text_complete_matches":@([textView.string isEqualToString:expectedText()]),
        @"text_followup_prefix_matches":@([textView.string isEqualToString:[expectedText() stringByAppendingString:@"ABCDEFG"]]),
        @"keyboard_mode":@(keyboardMode), @"text_focused":@(textView != nil && fixtureWindow.firstResponder == textView),
        @"text_focus_clicks":@(focusClicks),
        @"keyboard_typed_matches":@([textView.string isEqualToString:@"123"]),
        @"keyboard_deleted_matches":@([textView.string isEqualToString:@"12"]),
        @"keyboard_final_matches":@([textView.string isEqualToString:@"12\n"]),
        @"keyboard_chinese_matches":@([textView.string isEqualToString:@"\u4f60\u597d"]),
        @"keyboard_chinese_deleted_matches":@([textView.string isEqualToString:@"\u4f60"]),
        @"keyboard_chinese_final_matches":@([textView.string isEqualToString:@"\u4f60\n"]),
        @"backspace_downs":@(backspaceDowns), @"backspace_ups":@(backspaceUps),
        @"return_downs":@(returnDowns), @"return_ups":@(returnUps),
        @"keyboard_backspace_held":@(CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, 51)),
        @"keyboard_return_held":@(CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, 36)),
        @"keyboard_shift_held":@(CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, 56) || CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, 60))
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
    [data writeToFile:resultPath atomically:YES];
}

static void checkPoint(NSEvent *event, double expectedX) {
    if(fabs(event.locationInWindow.x-expectedX) > 0.5 || fabs(event.locationInWindow.y-100) > 0.5) pointErrors++;
}

@interface OBFRemoteInputCanvas : NSView
@end

@interface OBFRemoteTextView : NSTextView
@end
@implementation OBFRemoteTextView
- (void)mouseDown:(NSEvent *)event {
    focusClicks++; publish(); [super mouseDown:event]; publish();
}
- (void)keyDown:(NSEvent *)event {
    BOOL physical = keyboardMode && (event.keyCode == 51 || event.keyCode == 36);
    if ((!physical && event.keyCode != 0) || (event.modifierFlags & (NSEventModifierFlagShift | NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagCommand))) unexpectedKeys++;
    if (keyboardMode && event.keyCode == 51) backspaceDowns++;
    if (keyboardMode && event.keyCode == 36) returnDowns++;
    textDowns++;
    [super keyDown:event];
    publish();
}
- (void)keyUp:(NSEvent *)event {
    if (keyboardMode && event.keyCode == 51) backspaceUps++;
    if (keyboardMode && event.keyCode == 36) returnUps++;
    textUps++; publish();
}
@end
@implementation OBFRemoteInputCanvas
- (BOOL)acceptsFirstResponder { return YES; }
- (void)drawRect:(NSRect)rect {
    [NSColor.windowBackgroundColor setFill]; NSRectFill(self.bounds);
    [@"OpenBitFun Remote Input Fixture\nNative input test in progress" drawInRect:NSInsetRect(self.bounds,16,16)
        withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:20], NSForegroundColorAttributeName:NSColor.labelColor}];
}
- (void)mouseDown:(NSEvent *)event {
    checkPoint(event,120);
    downs++; [clicks addObject:@(event.clickCount)]; [downTimes addObject:@(event.timestamp)];
    [quartzClickCounts addObject:@(CGEventGetIntegerValueField(event.CGEvent, kCGMouseEventClickState))]; publish();
}
- (void)mouseUp:(NSEvent *)event { ups++; checkPoint(event,ups == 3 ? 140 : 120); publish(); }
- (void)mouseDragged:(NSEvent *)event { drags++; checkPoint(event,140); publish(); }
- (void)keyDown:(NSEvent *)event {
    if(event.keyCode == 0) { keyDowns++; if(event.modifierFlags & NSEventModifierFlagShift) shiftedKeys++; }
    else unexpectedKeys++;
    publish();
}
- (void)keyUp:(NSEvent *)event { if(event.keyCode == 0) keyUps++; else unexpectedKeys++; publish(); }
- (void)flagsChanged:(NSEvent *)event {
    if(event.keyCode != 56 && event.keyCode != 60) unexpectedKeys++;
    shiftHeld = (event.modifierFlags & NSEventModifierFlagShift) != 0; publish();
}
@end

int main(int argc, const char **argv) { @autoreleasepool {
    if(argc != 2 && argc != 3) return 2;
    textMode = argc == 3 && strcmp(argv[2], "--text") == 0;
    keyboardMode = argc == 3 && strcmp(argv[2], "--keyboard") == 0;
    BOOL wideCanvas = argc == 3 && strcmp(argv[2], "--wide") == 0;
    if(argc == 3 && !textMode && !wideCanvas && !keyboardMode) return 2;
    CGFloat canvasWidth = wideCanvas ? 1100 : 440;
    resultPath = [NSString stringWithUTF8String:argv[1]];
    clicks = [NSMutableArray array];
    downTimes = [NSMutableArray array]; quartzClickCounts = [NSMutableArray array];
    NSApplication *app = NSApplication.sharedApplication;
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    fixtureWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(160,160,canvasWidth,280)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    fixtureWindow.title = @"OpenBitFun Remote Input Fixture";
    fixtureWindow.releasedWhenClosed = NO;
    if (textMode || keyboardMode) {
        textView = [[OBFRemoteTextView alloc] initWithFrame:NSMakeRect(0,0,440,280)];
        textView.richText = NO;
        textView.automaticQuoteSubstitutionEnabled = NO;
        textView.automaticDashSubstitutionEnabled = NO;
        textView.automaticTextReplacementEnabled = NO;
        textView.continuousSpellCheckingEnabled = NO;
        if (keyboardMode) {
            NSView *canvas = [[OBFRemoteInputCanvas alloc] initWithFrame:NSMakeRect(0,0,440,280)];
            fixtureWindow.contentView = canvas;
            textView.frame = NSInsetRect(canvas.bounds,24,44);
            [canvas addSubview:textView];
        } else fixtureWindow.contentView = textView;
    } else fixtureWindow.contentView = [[OBFRemoteInputCanvas alloc] initWithFrame:NSMakeRect(0,0,canvasWidth,280)];
    [app finishLaunching];
    [fixtureWindow makeKeyAndOrderFront:nil];
    [fixtureWindow makeFirstResponder:fixtureWindow.contentView];
    // One activation at fixture startup. Never re-activate after the user
    // changes focus: the injector's foreground gate must then reject input.
    [app activateIgnoringOtherApps:YES];
    dispatch_async(dispatch_get_main_queue(), ^{
        [fixtureWindow makeKeyAndOrderFront:nil];
        [fixtureWindow makeFirstResponder:fixtureWindow.contentView];
        publish();
    });
    [NSTimer scheduledTimerWithTimeInterval:0.02 repeats:YES block:^(NSTimer *timer) { publish(); }];
    publish();
    printf("READY %d\n",getpid()); fflush(stdout);
    [app run];
} }
