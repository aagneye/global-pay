import 'package:flutter/material.dart';

class PlaceholderAction {
  const PlaceholderAction(this.label, this.onPressed);

  final String label;
  final VoidCallback onPressed;
}

/// Skeleton screen used until a feature is built. It shows what the screen will do
/// and in which iteration, and links the flow so the whole app can be clicked through.
class PlaceholderView extends StatelessWidget {
  const PlaceholderView({
    super.key,
    required this.title,
    required this.description,
    required this.iteration,
    this.actions = const [],
  });

  final String title;
  final String description;
  final int iteration;
  final List<PlaceholderAction> actions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(description, style: theme.textTheme.bodyLarge),
              const SizedBox(height: 12),
              Text(
                'Built in iteration $iteration',
                style: theme.textTheme.labelMedium?.copyWith(color: theme.colorScheme.outline),
              ),
              const Spacer(),
              for (final (index, action) in actions.indexed)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: index == 0
                      ? FilledButton(onPressed: action.onPressed, child: Text(action.label))
                      : OutlinedButton(onPressed: action.onPressed, child: Text(action.label)),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
